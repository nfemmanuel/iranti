# ADR 001: AGPL-3.0 License

**Status:** Accepted

**Date:** 2024-01-10

**Deciders:** Core team

---

## Context

Iranti is memory infrastructure for multi-agent AI systems. We need to choose a license that:

1. Allows free self-hosting for individuals and companies
2. Protects the project if someone offers it as a hosted service
3. Ensures improvements to the core system remain open
4. Aligns with our values of open infrastructure

We considered several options:

- **MIT/Apache** — Permissive, allows proprietary forks
- **GPL-3.0** — Copyleft, but has a "network use" loophole
- **AGPL-3.0** — Copyleft with network use clause
- **Business Source License** — Eventually open, but not immediately
- **Dual licensing** — Open for self-hosting, commercial for hosted

---

## Decision

We will use **AGPL-3.0** (GNU Affero General Public License version 3.0).

---

## Rationale

### Self-Hosting Freedom

AGPL allows anyone to:
- Download and run Iranti for free
- Modify it for their own use
- Deploy it internally in their company
- Use it in production without paying us

This is critical. We want Iranti to be infrastructure that anyone can use.

### Hosted Service Protection

The key difference between GPL and AGPL is the "network use" clause:

**GPL:** If you modify the software and offer it as a service over a network, you don't have to share your modifications.

**AGPL:** If you modify the software and offer it as a service over a network, you **must** share your modifications under AGPL.

This means:
- If someone offers "Iranti as a Service", they must open-source their modifications
- They can't take our work, add proprietary features, and sell it as a closed service
- Any improvements they make must flow back to the community

### Why Not MIT/Apache?

MIT and Apache are permissive licenses. They allow:
- Taking the code and making it proprietary
- Offering it as a closed hosted service
- Never contributing improvements back

This would allow a large company to:
1. Take Iranti
2. Add proprietary features
3. Offer "Iranti Cloud" as a paid service
4. Never share improvements
5. Compete with the open-source project using its own code

We don't want this. Infrastructure should remain open.

### Why Not Dual Licensing?

Dual licensing (open for self-hosting, commercial for hosted) is common for databases (e.g., MongoDB, Elastic).

Problems:
- Complex to enforce
- Requires a CLA (Contributor License Agreement)
- Creates friction for contributors
- Feels less "truly open"

AGPL achieves the same goal more simply: hosted services must remain open.

### Why Not Business Source License?

BSL (used by MariaDB, CockroachDB) is "eventually open" — it becomes open-source after a time period.

Problems:
- Not immediately open
- Confusing for users ("is this open-source or not?")
- Doesn't align with our values

We want Iranti to be open from day one.

---

## Consequences

### Positive

1. **Free self-hosting** — Anyone can run Iranti for free, forever
2. **Improvements stay open** — Hosted services must share their code
3. **Community benefits** — All improvements flow back to the project
4. **Clear licensing** — No confusion about what's allowed
5. **Aligned incentives** — We can offer a hosted service without competing with proprietary forks

### Negative

1. **Some companies avoid AGPL** — Some enterprises have blanket bans on AGPL software
2. **Contributor friction** — Some developers prefer permissive licenses
3. **Hosted service complexity** — Hosted services must open-source their modifications (but this is intentional)

### Neutral

1. **Can still offer commercial services** — We can offer:
   - Hosted Iranti (must be open-source)
   - Support contracts
   - Custom development
   - Training and consulting

2. **Can still have proprietary clients** — The AGPL applies to Iranti itself, not to:
   - Agent systems that use Iranti
   - Client libraries
   - Applications built on top of Iranti

---

## Alternatives Considered

### MIT License

**Pros:**
- Most permissive
- No restrictions on use
- Widely accepted

**Cons:**
- Allows proprietary forks
- No protection for hosted services
- Improvements don't flow back

**Rejected because:** Doesn't protect the project from proprietary hosted services.

### GPL-3.0

**Pros:**
- Copyleft
- Improvements must be shared
- Well-understood

**Cons:**
- Network use loophole
- Hosted services don't have to share code

**Rejected because:** Doesn't cover hosted services (the main use case for Iranti).

### Business Source License

**Pros:**
- Eventually open
- Protects commercial interests
- Used by successful projects

**Cons:**
- Not immediately open
- Confusing for users
- Requires time-based conversion

**Rejected because:** Not truly open-source from day one.

### Dual Licensing (AGPL + Commercial)

**Pros:**
- Open for self-hosting
- Commercial option for those who want it
- Common model

**Cons:**
- Requires CLA
- Complex to enforce
- Creates two classes of users

**Rejected because:** AGPL alone achieves the same goal more simply.

---

## Implementation

### License File

Add `LICENSE` file to repository:

```
GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007
[full license text]
```

### README Notice

Add to README.md:

```markdown
## License

AGPL-3.0 — free to self-host. If you offer Iranti as a hosted service, the source must remain open.
```

### Source File Headers

Add to all source files:

```typescript
/*
 * Iranti - Memory infrastructure for multi-agent AI systems
 * Copyright (C) 2024 [Your Name/Organization]
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */
```

### Documentation

Add licensing guide to docs:

- What AGPL means for users
- What AGPL means for hosted services
- What AGPL means for contributors
- FAQ about common questions

---

## FAQ

### Can I use Iranti in my company?

**Yes.** AGPL allows free use, including in commercial settings. You can:
- Run Iranti internally
- Use it in production
- Modify it for your needs

You only need to share code if you offer Iranti as a service to others.

### Can I offer Iranti as a hosted service?

**Yes.** But you must:
- Open-source your modifications under AGPL
- Provide source code to your users
- Keep the AGPL license

### Can I build proprietary software on top of Iranti?

**Yes.** The AGPL applies to Iranti itself, not to:
- Your agent systems that use Iranti
- Your applications that connect to Iranti
- Your client libraries

As long as you're using Iranti as infrastructure (via API or SDK), your code can be proprietary.

### Can I fork Iranti and make it proprietary?

**No.** AGPL requires that forks remain open-source. If you modify Iranti, your modifications must be AGPL.

### What if I don't want to use AGPL software?

Use a different solution. We chose AGPL intentionally to keep infrastructure open.

---

## References

- [GNU AGPL-3.0 License Text](https://www.gnu.org/licenses/agpl-3.0.en.html)
- [AGPL vs GPL: What's the Difference?](https://www.gnu.org/licenses/why-affero-gpl.html)
- [MongoDB's License Change](https://www.mongodb.com/licensing/server-side-public-license/faq)
- [Elastic's License Change](https://www.elastic.co/blog/licensing-change)

---

## Revision History

- **2024-01-10:** Initial decision (AGPL-3.0)
