# iranti-web PRD

**Status:** template  
**[Back to map](../MAP.md)**

---

> iranti-web is out of scope for the current build. This is a placeholder for when the time comes.

## Overview

iranti-web brings persistent memory to general chatbot interfaces such as Claude.ai and ChatGPT. Unlike iranti-core, which assumes the host agent can install and run a local server, iranti-web operates in a browser environment where no direct installation is possible.

## What we know so far

- iranti-web is a separate product built on top of iranti-core.
- The primary audience is general chatbot users who cannot install iranti directly.
- The integration path is fundamentally different from iranti-core: web-based hosts have no MCP support, no local server, and no CLI.
- iranti-core must be done enough (see [§13](../rough-notes/iranti-core-prd.md#13-open-items)) before iranti-web design starts.

## Open questions

- How does iranti-web connect to the browser without a local server?
- What subset of iranti-core features are available in a browser environment?
- What are the privacy and data storage constraints specific to browser-based memory?
- Does iranti-web require its own backend, or does it talk to the same iranti-core server?

## Prerequisites before writing this PRD

- iranti-core done enough
- Cloud account spec complete (iranti-web likely requires a server-side component)

---

_Fill this out when iranti-core is stable and the web use case is ready to be designed properly._
