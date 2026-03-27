# Manual Release Validation Checklist

This checklist complements [docs/guides/releasing.md](../guides/releasing.md).

Use it when we want a human-readable release gate for `iranti` itself, not just the automated workflow output.

It is intentionally narrow:
- local install and upgrade behavior
- real runtime lifecycle behavior
- real Claude/Codex integration behavior
- the product claims we most often repeat

---

## 1. Version and packaging sanity

- [ ] `package.json`, `clients/typescript/package.json`, `clients/python/pyproject.toml`, and `clients/python/iranti.py` all agree
- [ ] `npm run release:check -- vX.Y.Z` passes
- [ ] `npm pack` succeeds
- [ ] `npm pack ./clients/typescript` succeeds
- [ ] `python -m build clients/python --outdir clients/python/dist` succeeds
- [ ] `python -m twine check clients/python/dist/*` succeeds

---

## 2. Core build and automated gates

- [ ] `npm run build`
- [ ] `npm --prefix clients/typescript run build`
- [ ] `npm run test:hardening-fast`
- [ ] `npm run test:hardening-db`

If one of these is intentionally skipped, capture the reason before release.

---

## 3. CLI lifecycle checks

- [ ] `iranti --version` shows the expected version after install or upgrade
- [ ] `iranti status` works on the active machine
- [ ] `iranti doctor` works on the active machine
- [ ] `iranti instance create` works with a fresh instance root
- [ ] `iranti instance run` starts the instance cleanly
- [ ] `iranti instance restart` preserves expected runtime behavior
- [ ] `iranti configure project` updates `.env.iranti` without dropping current fields
- [ ] `iranti codex-setup` completes without corrupting Codex config

---

## 4. Personal and project memory checks

Use a fresh personal key and one project-scoped key.

### Personal memory

- [ ] write a fresh user preference through a real interface
- [ ] confirm it lands on `user/main`
- [ ] recall it from a different session or interface

### Project memory

- [ ] write a project fact like `next_step`
- [ ] confirm it lands on the project entity
- [ ] verify a different project does not inherit it unless intentionally shared

---

## 5. Claude and Codex integration checks

- [ ] Claude Code CLI can write and recall a personal fact
- [ ] Claude Code VS Code can write and recall a personal fact
- [ ] Codex CLI can recall the same personal fact
- [ ] Codex VS Code can explicitly call `iranti_query`
- [ ] Codex VS Code can answer a normal recall prompt after MCP wiring is present
- [ ] `.vscode/mcp.json` scaffolding works where expected

If Codex VS Code fails, separate "tool not exposed" from "tool returned wrong data".

---

## 6. Agent-generated memory checks

- [ ] Claude structured summary persistence works for a response like `The next step is ...`
- [ ] Codex can persist a structured summary through `iranti_remember_response`
- [ ] another session can pick that fact up correctly

---

## 7. Upgrade-specific checks

- [ ] `iranti upgrade --check` shows a coherent plan
- [ ] upgrading does not silently drop project binding fields like `IRANTI_AUTO_REMEMBER`
- [ ] bindings preserve `IRANTI_PERSONAL_MEMORY_ENTITY`
- [ ] existing runtimes behave as expected after restart on the new version

---

## 8. Notes to capture before ship

Record these explicitly if they apply:

- blocked platform-specific validation
- environment-specific warnings from `iranti doctor`
- known limitations we are intentionally shipping
- any benchmark or marketing claim that still needs narrower wording
