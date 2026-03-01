# Deployment Guide

How to deploy and use Iranti across different devices.

---

## Architecture Overview

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Your Laptop   │         │  Server/Cloud   │         │  Other Device   │
│                 │         │                 │         │                 │
│  Browser with   │◄────────┤  Iranti API     │────────►│  Python Agents  │
│  Chrome Ext     │  HTTP   │  + PostgreSQL   │  HTTP   │  (CrewAI, etc)  │
└─────────────────┘         └─────────────────┘         └─────────────────┘
```

**Key Point**: Iranti server runs in ONE place. Everything else connects to it via HTTP.

---

## Deployment Options

### Option 1: Local Development (Single Device)

**Use case**: Testing, development, personal use

```bash
# On your laptop
cd iranti
docker-compose up -d  # PostgreSQL
npm run api           # Iranti server on localhost:3001

# Browser extension points to localhost:3001
# Python agents point to localhost:3001
```

**Pros**: Simple, no network configuration  
**Cons**: Only works on one device

---

### Option 2: Server Deployment (Multi-Device)

**Use case**: Team collaboration, production, multiple devices

#### Step 1: Deploy Iranti Server

**On a server (AWS, DigitalOcean, your home server, etc.)**:

```bash
# 1. Clone repo
git clone https://github.com/nfemmanuel/iranti
cd iranti

# 2. Configure environment
cp .env.example .env
nano .env

# Set these:
DATABASE_URL=postgresql://user:pass@localhost:5432/iranti
IRANTI_API_KEY=your_secure_key_here
IRANTI_PORT=3001
NODE_ENV=production

# 3. Start PostgreSQL
docker-compose up -d

# 4. Install and setup
npm install
npm run setup

# 5. Start API server (production)
npm run api

# Or use PM2 for auto-restart:
npm install -g pm2
pm2 start npm --name iranti -- run api
pm2 save
pm2 startup
```

**Make server accessible**:
- Open port 3001 in firewall
- Or use nginx reverse proxy on port 80/443
- Get server IP or domain (e.g., `iranti.yourcompany.com`)

#### Step 2: Use from Browser (Any Device)

**On your laptop, tablet, phone**:

1. Install Chrome extension (see `clients/middleware/BROWSER_INTEGRATION.md`)

2. Edit `content.js`:
   ```javascript
   const IRANTI_URL = 'http://your-server-ip:3001';  // Change this
   const IRANTI_API_KEY = 'your_secure_key_here';
   ```

3. Load extension in Chrome

4. Visit claude.ai or chat.openai.com - memory now works!

#### Step 3: Use from Python Agents (Any Device)

**On your work laptop, home desktop, cloud VM**:

```bash
# 1. Install Python client
pip install requests python-dotenv

# 2. Copy client files
# Download these from your Iranti repo:
# - clients/python/iranti.py
# - clients/middleware/iranti_middleware.py

# 3. Configure
export IRANTI_URL=http://your-server-ip:3001
export IRANTI_API_KEY=your_secure_key_here

# 4. Use in your code
from iranti import IrantiClient

client = IrantiClient(
    base_url="http://your-server-ip:3001",
    api_key="your_secure_key_here"
)

# Now all agents on this device share memory via the server
```

---

## Production Deployment Checklist

### Security

- [ ] Change default API key in `.env`
- [ ] Use HTTPS (nginx + Let's Encrypt)
- [ ] Restrict PostgreSQL to localhost only
- [ ] Set strong PostgreSQL password
- [ ] Use firewall to limit port 3001 access
- [ ] Consider VPN for team access

### Reliability

- [ ] Use PM2 or systemd for auto-restart
- [ ] Set up PostgreSQL backups
- [ ] Monitor disk space (PostgreSQL grows over time)
- [ ] Set up logging (PM2 logs or systemd journal)

### Performance

- [ ] Use PostgreSQL connection pooling (already configured)
- [ ] Consider Redis for caching (future enhancement)
- [ ] Monitor API response times
- [ ] Scale PostgreSQL if needed (vertical scaling works well)

---

## Example: Team Setup

**Scenario**: 3 developers, 1 shared Iranti server

### Server (AWS EC2 or similar)

```bash
# Deploy once
ssh ubuntu@iranti-server.company.com
git clone https://github.com/nfemmanuel/iranti
cd iranti
# ... follow deployment steps above ...

# Server now running at http://iranti-server.company.com:3001
```

### Developer 1 (Laptop with Browser)

```bash
# Install Chrome extension
# Edit content.js:
const IRANTI_URL = 'http://iranti-server.company.com:3001';
const IRANTI_API_KEY = 'team_shared_key';

# Use Claude.ai - memory persists across all team members
```

### Developer 2 (Desktop with Python Agents)

```python
# agents.py
from iranti import IrantiClient

client = IrantiClient(
    base_url="http://iranti-server.company.com:3001",
    api_key="team_shared_key"
)

# Write facts - visible to everyone
client.write(
    entity="project/alpha",
    key="status",
    value={"data": "Phase 2 complete"},
    summary="status: Phase 2 complete",
    confidence=90,
    source="dev2_agent",
    agent="developer_2"
)
```

### Developer 3 (Remote Laptop)

```python
# Same setup, different agent ID
client = IrantiClient(
    base_url="http://iranti-server.company.com:3001",
    api_key="team_shared_key"
)

# Read facts written by Dev 2
facts = client.query_all("project/alpha")
# Sees "Phase 2 complete" from Dev 2's agent
```

**Result**: All 3 developers share the same knowledge base. Facts written by one are immediately available to others.

---

## Network Configuration

### Local Network (Home/Office)

```bash
# Server on local network (e.g., 192.168.1.100)
# Clients use: http://192.168.1.100:3001
```

### Cloud Deployment

```bash
# Server on cloud (e.g., AWS)
# Get public IP or domain
# Clients use: http://3.123.45.67:3001
# Or: http://iranti.yourcompany.com:3001
```

### HTTPS Setup (Recommended for Production)

```bash
# Install nginx
sudo apt install nginx certbot python3-certbot-nginx

# Configure nginx reverse proxy
sudo nano /etc/nginx/sites-available/iranti

# Add:
server {
    listen 80;
    server_name iranti.yourcompany.com;
    
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

# Enable site
sudo ln -s /etc/nginx/sites-available/iranti /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# Get SSL certificate
sudo certbot --nginx -d iranti.yourcompany.com

# Now clients use: https://iranti.yourcompany.com
```

---

## Client Configuration Files

### Browser Extension

**manifest.json** - no changes needed

**content.js** - update these lines:
```javascript
const IRANTI_URL = 'https://iranti.yourcompany.com';  // Your server
const IRANTI_API_KEY = 'your_key_here';                // Your API key
```

### Python Agents

**Option A: Environment variables** (recommended)
```bash
export IRANTI_URL=https://iranti.yourcompany.com
export IRANTI_API_KEY=your_key_here
```

**Option B: Code configuration**
```python
client = IrantiClient(
    base_url="https://iranti.yourcompany.com",
    api_key="your_key_here"
)
```

**Option C: .env file**
```bash
# .env
IRANTI_URL=https://iranti.yourcompany.com
IRANTI_API_KEY=your_key_here
```

```python
from dotenv import load_dotenv
load_dotenv()

client = IrantiClient()  # Reads from env vars
```

---

## Troubleshooting

### "Connection refused"

- Check server is running: `curl http://your-server:3001/health`
- Check firewall allows port 3001
- Check server IP/domain is correct

### "401 Unauthorized"

- API key mismatch
- Check `.env` on server matches client config

### "Slow responses"

- Check network latency: `ping your-server`
- Check PostgreSQL performance
- Consider deploying server closer to clients

### "Facts not syncing"

- All clients must point to SAME server URL
- Check API key is identical across all clients
- Verify facts exist: `curl -H "X-Iranti-Key: key" http://server:3001/query/project/test`

---

## Quick Start Commands

### Deploy Server
```bash
git clone https://github.com/nfemmanuel/iranti
cd iranti
cp .env.example .env
# Edit .env with your settings
docker-compose up -d
npm install && npm run setup
npm run api
```

### Configure Browser Extension
```bash
# Edit clients/middleware/iranti-extension/content.js
# Change IRANTI_URL to your server
# Load extension in Chrome
```

### Configure Python Client
```bash
pip install requests python-dotenv
export IRANTI_URL=http://your-server:3001
export IRANTI_API_KEY=your_key
python your_agent.py
```

---

## Summary

1. **Server**: Deploy once, runs continuously
2. **Browser**: Install extension, point to server
3. **Agents**: Install Python client, point to server
4. **All devices share the same PostgreSQL database**

No complex setup. Just HTTP connections to a central server.
