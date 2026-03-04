# Publishing the Python Client to PyPI

This guide publishes the Python client from `clients/python/`.

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

## Publish to PyPI

```bash
python -m twine upload dist/*
```

Use token auth:

- username: `__token__`
- password: `pypi-...`

## Versioning

Before each release, bump both:

1. `clients/python/pyproject.toml` -> `project.version`
2. `clients/python/iranti.py` -> `__version__`

Then tag and push:

```bash
git tag v0.1.1
git push origin v0.1.1
```

## Troubleshooting

- `File already exists`: version already published, bump version.
- `Invalid distribution`: rebuild (`python -m build`) and retry.
- `Authentication failed`: check PyPI token scope and account/project access.
