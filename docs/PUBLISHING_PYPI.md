# Publishing to PyPI

Guide for publishing Iranti Python client to PyPI.

## Prerequisites

```bash
pip install build twine
```

## Build Package

```bash
# Clean previous builds
rm -rf dist/ build/ *.egg-info

# Build package
python -m build

# This creates:
# - dist/iranti-0.1.0.tar.gz (source distribution)
# - dist/iranti-0.1.0-py3-none-any.whl (wheel)
```

## Test Locally

```bash
# Install locally
pip install dist/iranti-0.1.0-py3-none-any.whl

# Test import
python -c "from iranti import IrantiClient; print('Success!')"

# Uninstall
pip uninstall iranti
```

## Publish to TestPyPI (Recommended First)

```bash
# Upload to TestPyPI
python -m twine upload --repository testpypi dist/*

# Test installation from TestPyPI
pip install --index-url https://test.pypi.org/simple/ iranti

# Test it works
python -c "from iranti import IrantiClient; print('Success!')"
```

## Publish to PyPI (Production)

```bash
# Upload to PyPI
python -m twine upload dist/*

# Enter credentials when prompted
# Username: __token__
# Password: pypi-... (your API token)
```

## Get PyPI API Token

1. Go to https://pypi.org/manage/account/token/
2. Create new API token
3. Scope: "Entire account" or "Project: iranti"
4. Save token securely

## Configure .pypirc (Optional)

```bash
# Create ~/.pypirc
cat > ~/.pypirc << EOF
[pypi]
username = __token__
password = pypi-your-token-here

[testpypi]
username = __token__
password = pypi-your-test-token-here
EOF

chmod 600 ~/.pypirc
```

## Version Bumping

Update version in:
1. `setup.py` - version="0.1.1"
2. `clients/python/iranti.py` - __version__ = "0.1.1"

```bash
# Tag release
git tag v0.1.1
git push origin v0.1.1
```

## Verify Published Package

```bash
# Check on PyPI
open https://pypi.org/project/iranti/

# Install from PyPI
pip install iranti

# Test
python -c "from iranti import IrantiClient; print(IrantiClient.__version__)"
```

## Troubleshooting

### "File already exists"
- Version already published
- Bump version number and rebuild

### "Invalid distribution"
- Check setup.py syntax
- Ensure all required files exist
- Run `python setup.py check`

### "Authentication failed"
- Check API token is correct
- Ensure token has correct scope
- Try re-creating token

## Automation with GitHub Actions

Create `.github/workflows/publish.yml`:

```yaml
name: Publish to PyPI

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-python@v4
        with:
          python-version: '3.10'
      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install build twine
      - name: Build package
        run: python -m build
      - name: Publish to PyPI
        env:
          TWINE_USERNAME: __token__
          TWINE_PASSWORD: ${{ secrets.PYPI_API_TOKEN }}
        run: twine upload dist/*
```

Add `PYPI_API_TOKEN` to GitHub repository secrets.

## Checklist

Before publishing:
- [ ] Update version in setup.py
- [ ] Update CHANGELOG.md
- [ ] Test package locally
- [ ] Test on TestPyPI
- [ ] Create git tag
- [ ] Publish to PyPI
- [ ] Verify installation works
- [ ] Update documentation
