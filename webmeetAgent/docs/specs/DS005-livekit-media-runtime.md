---
title: DS005-livekit-media-runtime
summary: Defines topology-resolved signaling, private Twirp assertions, external relay credentials, reconnect, release gates, and the current fail-closed reachability boundary.
---

# DS005-livekit-media-runtime

### DS004 - LiveKit Media Runtime

## Introduction

This specification defines the active LiveKit media runtime contract for WebMeet.

## Core Content

### Boundary

`webmeetAgent` owns rooms, membership, participant JWTs, chat, resources, recording commands, and controlled rejoin. `liveKitServerAgent` owns Redis, LiveKit Server, Egress, and supervisor health. Ploinky Router owns browser signaling and private administrative transport.

For every join, WebMeet reads the current unversioned media topology and uses the same-origin `/base-agent-additional-server/liveKitServerAgent/7880/` signaling path. It obtains short-lived external relay credentials from the private broker using an exact current-generation assertion. The material must include valid expiry and matching topology and publication generations. There is no static ICE or URL fallback.

Server-side RoomService calls use `/base-agent-additional-server/liveKitServerAgent/7880/twirp/livekit.RoomService/` on private Router `8081`. The request assertion binds the audience, caller generation, method, exact Twirp path, body digest, expiry, and nonce. Router consumes the assertion and preserves the LiveKit API JWT.

The verified rootless Podman transport cannot activate the private broker or private RoomService convention route for a default managed-bridge WebMeet runtime. Its `host.containers.internal:host-gateway` mapping terminates on the box outer-facing interface rather than loopback or an address assigned to the managed bridge. Binding private Router `8081` there would violate the approved interface boundary. Ploinky therefore leaves the affected selectors inactive and fails closed. WebMeet does not use public Router, a direct LiveKit target, a widened bind, host mode, or a forwarding sidecar as a fallback.

### Media and credential lifecycle

The SFU advertises one direct candidate at the configured public IPv4 and UDP `7882`. External TURN provides UDP and TLS/TCP relay. The long-term relay secret is absent from WebMeet environment and topology; only allowed current-generation consumers can mint short-lived material.

Before credential expiry and after browser network transitions, the room UI performs a controlled disconnect, resolves fresh join material, recreates the LiveKit connection, rejoins, and restores microphone/camera state. An active screen share is stopped and the user is told to press the real Share screen button again because display capture cannot be reacquired without a fresh browser user activation. Failure is visible and closed; stale material is not retried as a fallback. Refresh timers and network listeners are removed when the dashboard unloads.

### Screen-share release gate

With `SMOKE_WEBMEET_SCREEN=1`, the existing two-account smoke test requires two distinct authenticated identities in isolated browser contexts. It exercises the real screen-share button in both directions. For each direction it proves:

- local LiveKit ScreenShare publication and active UI state;
- a visible attached remote ScreenShare video with current media data;
- increasing screen-source outbound and inbound RTP packet/frame counters;
- selected ICE candidate-pair evidence proving both browsers use an active
non-relay UDP pair on the fixed `7882` mux; and
- local unpublication plus remote track removal before reversing direction.

The test retains chat and room cleanup and writes redacted trace, video, screenshots, publication identity, candidate-pair, and RTC diagnostics on failure. Screen mode never skips for environment or account absence.

The local screen lane deliberately does not claim that the selected address is the configured public IPv4. Separate native Linux x64 and arm64 lanes use two remote browsers on verified distinct external networks. There, direct UDP must select the configured public IPv4 and `7882` rather than `7881` or a private/discovered alternative; relay lanes must select external TURN/UDP and TURN/TLS respectively.

### Security

Participant JWTs remain room-scoped and temporal. Private assertions are not user/admin credentials. Unknown topology, inactive signaling, stale caller generation, replay, wrong path/body, invalid relay response, or expired join material fails before an upstream connection is created.

### Decisions & Questions

### Question #1: Why does the private media control path fail closed?

Response: The release contract requires a managed-bridge WebMeet process to reach private Router `8081` without making that listener outer-facing. The verified rootless `host-gateway` topology cannot provide that transport while preserving the approved bind boundary. Private Twirp, TURN brokerage, and the fresh-stack screen-share gate therefore remain inactive and fail closed.

## Conclusion

WebMeet's media contract is implemented only through the point that preserves the private-listener boundary. The blocked managed-bridge transport is never replaced by a compatibility path or counted as a passed end-to-end gate.
