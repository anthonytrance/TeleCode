package usecase

import (
	"context"
	"fmt"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types/events"
)

type telecodePairingClient interface {
	IsLoggedIn() bool
	IsConnected() bool
	Disconnect()
	Connect() error
	AddEventHandler(whatsmeow.EventHandler) uint32
	RemoveEventHandler(uint32) bool
}

// PairPhone requires the first QR readiness event, even when no QR is shown to
// the user. Each explicit retry gets a fresh socket and pairing reference.
func prepareTelecodePhonePairing(ctx context.Context, client telecodePairingClient) error {
	if client.IsLoggedIn() {
		return fmt.Errorf("refusing to replace an already linked WhatsApp session")
	}
	if client.IsConnected() {
		client.Disconnect()
	}
	ready := make(chan struct{}, 1)
	handler := client.AddEventHandler(func(event interface{}) {
		if _, ok := event.(*events.QR); ok {
			select { case ready <- struct{}{}: default: }
		}
	})
	defer client.RemoveEventHandler(handler)
	if err := client.Connect(); err != nil {
		return fmt.Errorf("connect for phone pairing: %w", err)
	}
	timer := time.NewTimer(25 * time.Second)
	defer timer.Stop()
	select {
	case <-ready:
		return nil
	case <-ctx.Done():
		client.Disconnect()
		return ctx.Err()
	case <-timer.C:
		client.Disconnect()
		return fmt.Errorf("WhatsApp did not confirm pairing readiness; no phone code was generated")
	}
}
