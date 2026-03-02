package ipc

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// DeviceInfo describes a discovered target device.
type DeviceInfo struct {
	ID      string   `json:"id"`                // e.g., "emulator-5554", "R3CN90ABCDE", "chromeos:host"
	Label   string   `json:"label"`             // Canonical display name
	Type    string   `json:"type"`              // "emulator" | "android" | "chromeos"
	State   string   `json:"state"`             // "running" | "stopped" | "connected" | ...
	Actions []string `json:"actions,omitempty"` // Supported actions for this specific entry
	AVD     string   `json:"avd,omitempty"`     // Legacy display label for older clients
}

// Discovery handles ADB-based device detection.
type Discovery struct {
	adbPath string
}

// NewDiscovery creates a discovery instance with the given adb binary path.
func NewDiscovery(adbPath string) *Discovery {
	return &Discovery{adbPath: adbPath}
}

// ListDevices returns all known devices (running ADB targets + stopped AVDs).
func (d *Discovery) ListDevices() ([]DeviceInfo, error) {
	running, err := d.listRunning()
	if err != nil {
		return nil, fmt.Errorf("listing running devices: %w", err)
	}

	avds, err := d.listAVDs()
	if err != nil {
		// AVD listing is optional (emulator binary might not be on PATH)
		avds = nil
	}

	// Build a set of AVD names that are running.
	runningAVDs := make(map[string]bool)
	for _, e := range running {
		if e.Type == "emulator" {
			runningAVDs[e.AVD] = true
		}
	}

	// Start with running emulators.
	result := make([]DeviceInfo, 0, len(running)+len(avds))
	result = append(result, running...)

	// Add stopped AVDs that aren't currently running.
	for _, avd := range avds {
		if !runningAVDs[avd] {
			result = append(result, DeviceInfo{
				ID:      "avd-" + avd,
				Label:   avd,
				Type:    "emulator",
				State:   "stopped",
				Actions: actionsForDevice("emulator", "stopped"),
				AVD:     avd,
			})
		}
	}

	// Manual ChromeOS entry (only shown when configured).
	if host := strings.TrimSpace(os.Getenv("CHROMEOS_HOST")); host != "" {
		result = append(result, DeviceInfo{
			ID:      "chromeos:" + host,
			Label:   "ChromeOS (" + host + ")",
			Type:    "chromeos",
			State:   "connected",
			Actions: actionsForDevice("chromeos", "connected"),
			AVD:     "ChromeOS (" + host + ")",
		})
	}

	return result, nil
}

// GRPCAddr returns the gRPC address for a running emulator.
// The emulator gRPC port is the console port + 3000 (convention).
// e.g., emulator-5554 → console port 5554 → gRPC port 8554.
func GRPCAddr(emulatorID string) string {
	// Extract port from ID like "emulator-5554"
	parts := strings.SplitN(emulatorID, "-", 2)
	if len(parts) != 2 {
		return "localhost:8554" // fallback
	}
	port := parts[1]
	// gRPC port = console port + 3000
	var consolePort int
	if _, err := fmt.Sscanf(port, "%d", &consolePort); err != nil {
		return "localhost:8554"
	}
	return fmt.Sprintf("localhost:%d", consolePort+3000)
}

// listRunning queries `adb devices` for running devices.
func (d *Discovery) listRunning() ([]DeviceInfo, error) {
	out, err := exec.Command(d.adbPath, "devices").Output()
	if err != nil {
		return nil, fmt.Errorf("running adb devices: %w", err)
	}
	return parseADBDevicesOutput(string(out), d.getAVDName), nil
}

func parseADBDevicesOutput(output string, getAVDName func(serial string) string) []DeviceInfo {
	var devices []DeviceInfo
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "List of") || strings.HasPrefix(line, "*") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		serial := fields[0]
		status := fields[1]
		if status != "device" {
			continue
		}

		if strings.HasPrefix(serial, "emulator-") {
			avdName := getAVDName(serial)
			devices = append(devices, DeviceInfo{
				ID:      serial,
				Label:   avdName,
				Type:    "emulator",
				State:   "running",
				Actions: actionsForDevice("emulator", "running"),
				AVD:     avdName,
			})
			continue
		}

		devices = append(devices, DeviceInfo{
			ID:      serial,
			Label:   serial,
			Type:    "android",
			State:   "running",
			Actions: actionsForDevice("android", "running"),
			AVD:     serial,
		})
	}

	return devices
}

func actionsForDevice(deviceType, state string) []string {
	switch deviceType {
	case "emulator":
		if state == "stopped" {
			return []string{"start"}
		}
		return []string{"stream", "stop", "screenshot"}
	case "android":
		return []string{"stream"}
	case "chromeos":
		return []string{"stream"}
	case "ios-simulator":
		return []string{"stream"}
	default:
		return nil
	}
}

// listAVDs queries `emulator -list-avds` for available AVD profiles.
func (d *Discovery) listAVDs() ([]string, error) {
	// The emulator binary is typically alongside adb in the SDK.
	// Try "emulator" on PATH first.
	out, err := exec.Command("emulator", "-list-avds").Output()
	if err != nil {
		return nil, fmt.Errorf("running emulator -list-avds: %w", err)
	}

	var avds []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			avds = append(avds, line)
		}
	}
	return avds, nil
}

// getAVDName queries the AVD name for a running emulator serial.
func (d *Discovery) getAVDName(serial string) string {
	// Connect to the emulator's console port to query the AVD name.
	// Serial is like "emulator-5554", console port is 5554.
	parts := strings.SplitN(serial, "-", 2)
	if len(parts) != 2 {
		return serial
	}
	port := parts[1]

	conn, err := net.DialTimeout("tcp", "localhost:"+port, 2*time.Second)
	if err != nil {
		return serial
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))

	// Read the greeting (may require multiple reads).
	greeting := readUntilOK(conn)

	// The console requires authentication. Read the auth token and authenticate.
	tokenPath := consoleAuthTokenPath(greeting)
	if tokenPath != "" {
		token, err := os.ReadFile(tokenPath)
		if err != nil {
			return serial
		}
		fmt.Fprintf(conn, "auth %s\n", strings.TrimSpace(string(token)))
		readUntilOK(conn) // consume auth response
	}

	// Send "avd name" command.
	fmt.Fprintf(conn, "avd name\n")

	response := readUntilOK(conn)
	for _, line := range strings.Split(response, "\n") {
		name := strings.TrimSpace(line)
		if name != "" && name != "OK" {
			return name
		}
	}

	return serial
}

// readUntilOK reads from the connection until it sees a line starting with "OK" or an error.
func readUntilOK(conn net.Conn) string {
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			sb.Write(buf[:n])
			if strings.Contains(sb.String(), "\nOK") || strings.HasPrefix(sb.String(), "OK") {
				break
			}
		}
		if err != nil {
			break
		}
	}
	return sb.String()
}

// consoleAuthTokenPath extracts the auth token file path from the console greeting.
// The greeting typically contains: "you can find your <auth_token> in '/path/to/token'"
func consoleAuthTokenPath(greeting string) string {
	// Look for the token path in the greeting
	if idx := strings.Index(greeting, "emulator_console_auth_token"); idx != -1 {
		// Walk backward to find the start of the path (after "in '")
		start := strings.LastIndex(greeting[:idx], "'")
		end := strings.Index(greeting[idx:], "'")
		if start >= 0 && end >= 0 {
			return greeting[start+1 : idx+end]
		}
	}

	// Fallback: try the default location
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	path := filepath.Join(home, ".emulator_console_auth_token")
	if _, err := os.Stat(path); err == nil {
		return path
	}
	return ""
}
