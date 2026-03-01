# Publishing to Docker Hub

Guide for publishing Iranti Docker image.

## Prerequisites

```bash
# Install Docker
# https://docs.docker.com/get-docker/

# Login to Docker Hub
docker login
# Enter username and password
```

## Build Image

```bash
# Build for your platform
docker build -t nfemmanuel/iranti:latest .

# Build for multiple platforms (requires buildx)
docker buildx create --use
docker buildx build --platform linux/amd64,linux/arm64 -t nfemmanuel/iranti:latest .
```

## Test Image Locally

```bash
# Run container
docker run -d \
  --name iranti-test \
  -p 3001:3001 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/iranti \
  -e IRANTI_API_KEY=test_key \
  nfemmanuel/iranti:latest

# Check logs
docker logs iranti-test

# Test health endpoint
curl http://localhost:3001/health

# Stop and remove
docker stop iranti-test
docker rm iranti-test
```

## Tag Versions

```bash
# Tag with version
docker tag nfemmanuel/iranti:latest nfemmanuel/iranti:0.1.0

# Tag with major version
docker tag nfemmanuel/iranti:latest nfemmanuel/iranti:0.1

# Tag with major only
docker tag nfemmanuel/iranti:latest nfemmanuel/iranti:0
```

## Push to Docker Hub

```bash
# Push all tags
docker push nfemmanuel/iranti:latest
docker push nfemmanuel/iranti:0.1.0
docker push nfemmanuel/iranti:0.1
docker push nfemmanuel/iranti:0

# Or push all at once
docker push --all-tags nfemmanuel/iranti
```

## Multi-Platform Build and Push

```bash
# Build and push for multiple platforms
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t nfemmanuel/iranti:latest \
  -t nfemmanuel/iranti:0.1.0 \
  --push \
  .
```

## Docker Compose for Production

Create `docker-compose.prod.yml`:

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: iranti
      POSTGRES_USER: iranti
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped

  iranti:
    image: nfemmanuel/iranti:latest
    ports:
      - "3001:3001"
    environment:
      DATABASE_URL: postgresql://iranti:${POSTGRES_PASSWORD}@postgres:5432/iranti
      IRANTI_API_KEY: ${IRANTI_API_KEY}
      NODE_ENV: production
    depends_on:
      - postgres
    restart: unless-stopped

volumes:
  postgres_data:
```

Usage:
```bash
# Set environment variables
export POSTGRES_PASSWORD=secure_password
export IRANTI_API_KEY=your_api_key

# Start services
docker-compose -f docker-compose.prod.yml up -d

# View logs
docker-compose -f docker-compose.prod.yml logs -f

# Stop services
docker-compose -f docker-compose.prod.yml down
```

## Verify Published Image

```bash
# Pull from Docker Hub
docker pull nfemmanuel/iranti:latest

# Run
docker run -d \
  -p 3001:3001 \
  -e DATABASE_URL=postgresql://... \
  -e IRANTI_API_KEY=... \
  nfemmanuel/iranti:latest

# Test
curl http://localhost:3001/health
```

## Automation with GitHub Actions

Create `.github/workflows/docker.yml`:

```yaml
name: Build and Push Docker Image

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v3

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v2

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Login to Docker Hub
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v4
        with:
          images: nfemmanuel/iranti
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=raw,value=latest

      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

Add secrets to GitHub repository:
- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

## Image Size Optimization

Current image: ~150MB (Alpine-based)

Further optimization:
```dockerfile
# Use distroless for even smaller image
FROM gcr.io/distroless/nodejs18-debian11

# Or use scratch with static binary
FROM scratch
COPY --from=builder /app/dist /app/dist
```

## Security Scanning

```bash
# Scan for vulnerabilities
docker scan nfemmanuel/iranti:latest

# Or use Trivy
trivy image nfemmanuel/iranti:latest
```

## Checklist

Before publishing:
- [ ] Test image locally
- [ ] Update version tags
- [ ] Scan for vulnerabilities
- [ ] Test multi-platform build
- [ ] Push to Docker Hub
- [ ] Verify pull works
- [ ] Update documentation
- [ ] Create docker-compose example
