# Publishing The Python Client To PyPI

This is the manual fallback path for publishing the Python client from `clients/python/`.

The canonical release flow for this repo lives in [guides/releasing.md](../guides/releasing.md). Use this doc only when you intentionally need a direct Python-package publishing path outside that workflow.

## Package Metadata

The Python package uses:

- `clients/python/pyproject.toml`
- module: `clients/python/iranti.py`
- license: AGPL-3.0-or-later (`clients/python/LICENSE`)

## Prerequisites

```bash
python -m pip install --upgrade pip
python -m pip install build twine
```

## Build

```bash
cd clients/python
python -m build
```

Artifacts:

- `dist/iranti-<version>.tar.gz`
- `dist/iranti-<version>-py3-none-any.whl`

## Local Validation

```bash
python -m pip install dist/iranti-0.1.0-py3-none-any.whl
python -c "import iranti; from iranti import IrantiClient; print(iranti.__version__)"
python -m pip uninstall -y iranti
```

## Publish to TestPyPI

```bash
python -m twine upload --repository testpypi dist/*
python -m pip install --index-url https://test.pypi.org/simple/ iranti
```

## Publish To PyPI

```bash
python -m twine upload dist/*
```

Use token auth if you are not using Trusted Publishing:

- username: `__token__`
- password: `pypi-...`

## Versioning

Before each release, bump both:

1. `clients/python/pyproject.toml` -> `project.version`
2. `clients/python/iranti.py` -> `__version__`

Then tag and push through the normal release flow:

```bash
git tag v<version>
git push origin v<version>
```

## Troubleshooting

- `File already exists`: version already published, bump version.
- `Invalid distribution`: rebuild (`python -m build`) and retry.
- `Authentication failed`: check PyPI token scope and account/project access.
