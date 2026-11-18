package usecase

import (
	"context"
	"fmt"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types/events"
)

type telecodePairingStub struct {
	connected, loggedIn, ready, removed bool
	disconnects, connects int
	handler whatsmeow.EventHandler
	connectError error
}
func (c *telecodePairingStub) IsConnected() bool { return c.connected }
func (c *telecodePairingStub) IsLoggedIn() bool { return c.loggedIn }
func (c *telecodePairingStub) Disconnect() { c.disconnects++; c.connected = false }
func (c *telecodePairingStub) Connect() error {
	c.connects++
	if c.connectError != nil { return c.connectError }
	c.connected = true
	if c.ready { c.handler(&events.QR{Codes: []string{"not-shown-to-user"}}) }
	return nil
}
func (c *telecodePairingStub) AddEventHandler(h whatsmeow.EventHandler) uint32 { c.handler = h; return 7 }
func (c *telecodePairingStub) RemoveEventHandler(id uint32) bool { c.removed = id == 7; return c.removed }

func TestTelecodePairingFreshReadiness(t *testing.T) {
	c := &telecodePairingStub{connected: true, ready: true}
	if err := prepareTelecodePhonePairing(context.Background(), c); err != nil { t.Fatal(err) }
	if c.connects != 1 || c.disconnects != 1 || !c.removed { t.Fatalf("unexpected lifecycle: %+v", c) }
}
func TestTelecodePairingRefusesLinkedSession(t *testing.T) {
	c := &telecodePairingStub{loggedIn: true, connected: true}
	if prepareTelecodePhonePairing(context.Background(), c) == nil { t.Fatal("linked session was replaced") }
	if c.connects != 0 || c.disconnects != 0 { t.Fatal("touched linked session") }
}
func TestTelecodePairingCancellationAndFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10 * time.Millisecond)
	defer cancel()
	c := &telecodePairingStub{}
	if prepareTelecodePhonePairing(ctx, c) == nil { t.Fatal("accepted absent readiness") }
	if c.disconnects != 1 || !c.removed { t.Fatal("cancelled connection not cleaned") }
	c = &telecodePairingStub{connectError: fmt.Errorf("offline")}
	if prepareTelecodePhonePairing(context.Background(), c) == nil || !c.removed { t.Fatal("connection error not cleaned") }
}
