# Performance Tuning Guide

Optimize Iranti for production workloads.

---

## Baseline Performance

Out of the box, Iranti handles:
- **Writes**: ~100 facts/second
- **Queries**: ~500 queries/second
- **Database**: 100K+ facts with <100ms query time
- **Memory**: ~200MB Node.js + ~500MB PostgreSQL

---

## PostgreSQL Optimization

### 1. Connection Pooling

Already configured in `src/library/db.ts`:
```typescript
const pool = new Pool({
  max: 20,  // Maximum connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

**Tune for your workload:**
```bash
# High concurrency (many agents)
max: 50

# Low memory (single agent)
max: 5
```

### 2. Indexes

Already created in migrations:
```sql
CREATE INDEX idx_kb_entity ON knowledge_base(entity_type, entity_id);
CREATE INDEX idx_kb_key ON knowledge_base(entity_type, entity_id, key);
CREATE INDEX idx_archive_entity ON archive(entity_type, entity_id);
```

**Add custom indexes for your queries:**
```sql
-- If you query by agent frequently
CREATE INDEX idx_kb_agent ON knowledge_base(agent);

-- If you query by source
CREATE INDEX idx_kb_source ON knowledge_base(source);

-- If you query by confidence
CREATE INDEX idx_kb_confidence ON knowledge_base(confidence);
```

### 3. Vacuum and Analyze

Run periodically:
```bash
# Weekly
psql $DATABASE_URL -c "VACUUM ANALYZE;"

# Monthly (reclaims disk space, requires downtime)
psql $DATABASE_URL -c "VACUUM FULL;"
```

### 4. PostgreSQL Configuration

Edit `postgresql.conf` or set in `docker-compose.yml`:
```yaml
postgres:
  environment:
    # Increase shared memory
    POSTGRES_SHARED_BUFFERS: 256MB
    
    # Increase work memory
    POSTGRES_WORK_MEM: 16MB
    
    # Increase maintenance work memory
    POSTGRES_MAINTENANCE_WORK_MEM: 128MB
    
    # Enable query planning
    POSTGRES_EFFECTIVE_CACHE_SIZE: 1GB
```

---

## Node.js Optimization

### 1. Memory Limits

Increase if handling large payloads:
```bash
export NODE_OPTIONS="--max-old-space-size=2048"
npm run api
```

### 2. Clustering

Run multiple Node.js processes:
```bash
# Install PM2
npm install -g pm2

# Start with clustering
pm2 start npm --name iranti -i 4 -- run api

# 4 = number of CPU cores
# PM2 handles load balancing
```

### 3. Caching (Future Enhancement)

Add Redis for frequently accessed facts:
```typescript
// Pseudo-code (not implemented yet)
const cached = await redis.get(`fact:${entity}:${key}`);
if (cached) return JSON.parse(cached);

const fact = await db.query(...);
await redis.setex(`fact:${entity}:${key}`, 300, JSON.stringify(fact));
return fact;
```

---

## API Optimization

### 1. Batch Operations

Instead of:
```python
for fact in facts:
    client.write(entity, fact['key'], fact['value'], ...)
```

Use (future feature):
```python
client.write_batch([
    {'entity': 'project/a', 'key': 'k1', ...},
    {'entity': 'project/a', 'key': 'k2', ...},
    {'entity': 'project/a', 'key': 'k3', ...},
])
```

### 2. Parallel Queries

Use async/await:
```python
import asyncio
import aiohttp

async def query_many(entities):
    async with aiohttp.ClientSession() as session:
        tasks = [
            session.get(f'{IRANTI_URL}/kb/query/{entity}')
            for entity in entities
        ]
        return await asyncio.gather(*tasks)

# Query 100 entities in parallel
results = asyncio.run(query_many(entities))
```

### 3. Reduce Payload Size

Use `summary` field instead of full `value`:
```python
# Heavy (sends full JSON)
client.write(
    entity="doc/large",
    key="content",
    value={"text": "10KB of text..."},  # Large
    summary="Document about X",  # Small
    ...
)

# Light (query returns summary by default)
fact = client.query("doc/large", "content")
print(fact.summary)  # Fast, small payload
```

---

## Network Optimization

### 1. Deploy Close to Clients

- If agents run in AWS us-east-1, deploy Iranti there
- If agents run locally, deploy on local network
- Latency matters: 1ms vs 100ms = 100x faster

### 2. Use HTTP/2

Enable in nginx:
```nginx
server {
    listen 443 ssl http2;  # Enable HTTP/2
    ...
}
```

### 3. Compress Responses

Enable gzip in nginx:
```nginx
gzip on;
gzip_types application/json;
gzip_min_length 1000;
```

---

## Database Scaling

### Vertical Scaling (Recommended First)

Increase PostgreSQL resources:
```yaml
# docker-compose.yml
postgres:
  deploy:
    resources:
      limits:
        cpus: '4'
        memory: 8G
```

### Horizontal Scaling (Future)

Read replicas for query-heavy workloads:
```
┌─────────┐
│ Primary │ ← Writes
└────┬────┘
     │
     ├─────► Replica 1 ← Reads
     ├─────► Replica 2 ← Reads
     └─────► Replica 3 ← Reads
```

### Partitioning (Future)

Partition by entity_type:
```sql
CREATE TABLE knowledge_base_projects PARTITION OF knowledge_base
FOR VALUES IN ('project');

CREATE TABLE knowledge_base_researchers PARTITION OF knowledge_base
FOR VALUES IN ('researcher');
```

---

## Monitoring

### 1. API Metrics

Add to `src/api/server.ts`:
```typescript
let requestCount = 0;
let totalLatency = 0;

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    requestCount++;
    totalLatency += Date.now() - start;
    
    if (requestCount % 100 === 0) {
      console.log(`Avg latency: ${totalLatency / requestCount}ms`);
    }
  });
  next();
});
```

### 2. Database Metrics

```sql
-- Query performance
SELECT query, calls, mean_exec_time, max_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Table sizes
SELECT schemaname, tablename, 
       pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename))
FROM pg_tables
WHERE schemaname='public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Index usage
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC;
```

### 3. System Metrics

```bash
# CPU usage
top -p $(pgrep -f "node.*api")

# Memory usage
ps aux | grep node

# Disk I/O
iostat -x 1

# Network
iftop
```

---

## Load Testing

### 1. Write Performance

```python
import time
from clients.python.iranti import IrantiClient

client = IrantiClient(base_url="http://localhost:3001", api_key="test")

start = time.time()
for i in range(1000):
    client.write(
        entity=f"test/entity_{i % 100}",
        key=f"key_{i}",
        value={"data": f"value_{i}"},
        summary=f"Test fact {i}",
        confidence=80,
        source="load_test",
        agent="test"
    )

elapsed = time.time() - start
print(f"Writes/sec: {1000 / elapsed:.2f}")
```

### 2. Query Performance

```python
start = time.time()
for i in range(1000):
    client.query_all(f"test/entity_{i % 100}")

elapsed = time.time() - start
print(f"Queries/sec: {1000 / elapsed:.2f}")
```

### 3. Concurrent Load

```python
import concurrent.futures

def write_fact(i):
    client.write(...)

with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
    futures = [executor.submit(write_fact, i) for i in range(1000)]
    concurrent.futures.wait(futures)
```

---

## Optimization Checklist

### Before Production

- [ ] Enable PostgreSQL connection pooling
- [ ] Add indexes for your query patterns
- [ ] Set up VACUUM schedule
- [ ] Configure PostgreSQL memory settings
- [ ] Enable gzip compression
- [ ] Set up monitoring
- [ ] Run load tests

### For High Traffic

- [ ] Use PM2 clustering
- [ ] Increase Node.js memory limit
- [ ] Deploy close to clients
- [ ] Use HTTP/2
- [ ] Consider read replicas
- [ ] Add Redis caching

### For Large Databases

- [ ] Partition tables by entity_type
- [ ] Archive old facts
- [ ] Increase PostgreSQL resources
- [ ] Optimize slow queries
- [ ] Consider sharding by entity_type

---

## Performance Targets

### Good Performance
- Write latency: <50ms
- Query latency: <20ms
- Throughput: 100+ req/sec
- Database: <1GB for 100K facts

### Excellent Performance
- Write latency: <10ms
- Query latency: <5ms
- Throughput: 1000+ req/sec
- Database: Optimized indexes, <100ms for any query

### When to Scale
- Latency >100ms consistently
- CPU >80% for >5 minutes
- Memory >90% of available
- Database >10GB without archiving
- Throughput hitting limits

---

## Benchmarking

Run included benchmarks:
```bash
cd clients/experiments
python stress_test.py
python stress_test_stellar.py
python visualize_stress_test.py
```

Expected results (local deployment):
- Stress test throughput and latency are reported in script output JSON/plots.
- Use `visualize_stress_test.py` to inspect percentile latency and throughput trends.

Cloud deployment adds network latency (~10-50ms per request).

---

## Further Reading

- PostgreSQL Performance: https://wiki.postgresql.org/wiki/Performance_Optimization
- Node.js Performance: https://nodejs.org/en/docs/guides/simple-profiling/
- PM2 Clustering: https://pm2.keymetrics.io/docs/usage/cluster-mode/
