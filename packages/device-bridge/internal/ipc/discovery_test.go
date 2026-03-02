package ipc

import "testing"

func TestParseADBDevicesOutputClassifiesMixedTargets(t *testing.T) {
	input := `List of devices attached
emulator-5554	device
R3CN90ABCDE	device
emulator-5556	offline
FA8X31A01234	unauthorized

`

	got := parseADBDevicesOutput(input, func(serial string) string {
		if serial == "emulator-5554" {
			return "Pixel_7_API_34"
		}
		return serial
	})

	if len(got) != 2 {
		t.Fatalf("expected 2 devices, got %d", len(got))
	}

	if got[0].ID != "emulator-5554" || got[0].Type != "emulator" || got[0].Label != "Pixel_7_API_34" || got[0].AVD != "Pixel_7_API_34" || got[0].State != "running" {
		t.Fatalf("unexpected emulator entry: %+v", got[0])
	}
	if got[1].ID != "R3CN90ABCDE" || got[1].Type != "android" || got[1].Label != "R3CN90ABCDE" || got[1].AVD != "R3CN90ABCDE" || got[1].State != "running" {
		t.Fatalf("unexpected android entry: %+v", got[1])
	}
}
