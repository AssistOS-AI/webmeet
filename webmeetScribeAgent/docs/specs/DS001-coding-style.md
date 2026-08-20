---
title: DS001-coding-style
summary: Defines source layout, runtime configuration, authorization, and test conventions for WebMeet Meeting Secretary.
---

# DS001 Coding Style

## Introduction

This specification defines the coding and verification rules for the Meeting Secretary worker.

## Core Content

The worker must use ES modules, explicit asynchronous control flow, bounded input handling, and durable state under its configured data path. Secrets and participant credentials must not be written to logs or documentation. All LLM interaction must use the runtime-configured LLMAgent class and its environment settings; repository-level manual overrides may replace environment defaults.

The worker may use AchillesAgentLib when supplied by the Ploinky runtime. Routing-sensitive documentation, orchestration, bootstrap, and testing tasks must carry the repository's task metadata tags when they are dispatched through the agent runtime.

Tests must remain under webmeetScribeAgent/tests/ and must be runnable with the local package test command. The worker must keep recovery and meeting-note behavior testable through isolated modules.

## Conclusion

The secretary remains a small, testable Ploinky worker with explicit runtime and collaboration boundaries.
