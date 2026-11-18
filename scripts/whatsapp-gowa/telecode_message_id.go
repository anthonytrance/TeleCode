package middleware

import (
	"context"
	"fmt"
	"regexp"

	"github.com/aldinokemal/go-whatsapp-web-multidevice/infrastructure/whatsapp"
)

var telecodeOutgoingID = regexp.MustCompile(`^[A-F0-9]{32}$`)

// Register the ID in TeleCode before transport submission, so even an echo
// arriving before the HTTP acknowledgement is identifiable without text labels.
func telecodeMessageContext(ctx context.Context, id string) (context.Context, error) {
	if id == "" { return ctx, nil }
	if !telecodeOutgoingID.MatchString(id) { return ctx, fmt.Errorf("invalid TeleCode outgoing message ID") }
	return whatsapp.ContextWithSendMessageID(ctx, id), nil
}
