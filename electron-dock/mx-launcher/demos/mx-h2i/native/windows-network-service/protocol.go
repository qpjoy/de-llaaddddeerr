package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const protocolVersion = 1
const serviceName = "MinCaveNetworkService"
const serviceVersion = "1.0.0"
const pipeName = `\\.\pipe\MinCave.Network.v1`
const maxFrameBytes = 2 * 1024 * 1024

type helloRequest struct {
	Protocol int    `json:"protocol"`
	Nonce    string `json:"nonce"`
	Key      string `json:"key"`
}

type helloResponse struct {
	Protocol  int    `json:"protocol"`
	Version   string `json:"version"`
	OwnerSID  string `json:"ownerSID"`
	Key       string `json:"key"`
	Signature string `json:"signature"`
}

type sealedFrame struct {
	Nonce string `json:"nonce"`
	Data  string `json:"data"`
}

type serviceRequest struct {
	Operation string          `json:"operation"`
	Input     json.RawMessage `json:"input,omitempty"`
}

type serviceResponse struct {
	OK      bool            `json:"ok"`
	Value   json.RawMessage `json:"value,omitempty"`
	Code    string          `json:"code,omitempty"`
	Message string          `json:"message,omitempty"`
}

func handshakeTranscript(request helloRequest, response helloResponse) []byte {
	return []byte(fmt.Sprintf("mincave-network/v1\n%s\n%s\n%s\n%s\n%s", request.Nonce, request.Key, response.Key, response.OwnerSID, response.Version))
}

func acceptHello(request helloRequest, sid string, signingKey ed25519.PrivateKey) (helloResponse, cipher.AEAD, error) {
	if request.Protocol != protocolVersion {
		return helloResponse{}, nil, errors.New("incompatible protocol")
	}
	nonce, err := base64.StdEncoding.DecodeString(request.Nonce)
	if err != nil || len(nonce) != 32 {
		return helloResponse{}, nil, errors.New("invalid handshake nonce")
	}
	clientKey, err := base64.StdEncoding.DecodeString(request.Key)
	if err != nil {
		return helloResponse{}, nil, errors.New("invalid client key")
	}
	peer, err := ecdh.X25519().NewPublicKey(clientKey)
	if err != nil {
		return helloResponse{}, nil, err
	}
	privateKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return helloResponse{}, nil, err
	}
	shared, err := privateKey.ECDH(peer)
	if err != nil {
		return helloResponse{}, nil, err
	}
	response := helloResponse{Protocol: protocolVersion, Version: serviceVersion, OwnerSID: sid, Key: base64.StdEncoding.EncodeToString(privateKey.PublicKey().Bytes())}
	response.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(signingKey, handshakeTranscript(request, response)))
	key := sha256.Sum256(append(shared, nonce...))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return helloResponse{}, nil, err
	}
	aead, err := cipher.NewGCM(block)
	return response, aead, err
}

func seal(aead cipher.AEAD, value any) (sealedFrame, error) {
	plain, err := json.Marshal(value)
	if err != nil {
		return sealedFrame{}, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return sealedFrame{}, err
	}
	return sealedFrame{Nonce: base64.StdEncoding.EncodeToString(nonce), Data: base64.StdEncoding.EncodeToString(aead.Seal(nil, nonce, plain, []byte("mincave-response/v1")))}, nil
}

func openRequest(aead cipher.AEAD, frame sealedFrame) (serviceRequest, error) {
	nonce, err := base64.StdEncoding.DecodeString(frame.Nonce)
	if err != nil || len(nonce) != aead.NonceSize() {
		return serviceRequest{}, errors.New("invalid frame nonce")
	}
	data, err := base64.StdEncoding.DecodeString(frame.Data)
	if err != nil || len(data) > maxFrameBytes {
		return serviceRequest{}, errors.New("invalid frame size")
	}
	plain, err := aead.Open(nil, nonce, data, []byte("mincave-request/v1"))
	if err != nil {
		return serviceRequest{}, errors.New("invalid authenticated frame")
	}
	var request serviceRequest
	if err = json.Unmarshal(plain, &request); err != nil {
		return request, errors.New("invalid request")
	}
	switch request.Operation {
	case "capabilities", "wireguard", "legacy-hdo.cleanup", "mihomo.start", "mihomo.stop", "mihomo.status", "mihomo.api", "mihomo.reload":
		return request, nil
	default:
		return request, errors.New("unsupported network operation")
	}
}
