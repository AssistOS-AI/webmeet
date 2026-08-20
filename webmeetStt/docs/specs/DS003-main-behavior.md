---
title: DS003-main-behavior
summary: Defines private transcription for WebMeet audio workers.
---

# DS003 Main Behavior

## Introduction

WebMeet STT converts audio supplied by an internal WebMeet worker into transcript text for downstream meeting workflows.

## Core Content

### Private transcription service

The affected actor is an internal WebMeet audio worker. It sends audio to the STT service through the private webmeet bridge, where Faster-Whisper applies the configured model, language, device, compute type, and optional DTLN denoise settings. The observable result is transcript text delivered to the internal caller. The governing boundary is that the service has no public browser route, physical-host publication, or direct user-facing tool contract.

## Conclusion

The STT behavior is complete when internal WebMeet consumers can obtain transcript text while the network and storage boundary remains private.
