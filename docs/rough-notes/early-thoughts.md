# Iranti Early thoughts
This is just me recording some very rough thoughts for what Iranti needs to be needs to contain, etc. I am calling this my ramblings because I fully intend to organize it better as time goes on.

## How the Docs Might Work
At this early stage there will likely be thoughts about what needs to be done, just in some zig zag order. Then when the time comes to write the actual docs, I will likely begin with an organized version that serves as a semi-comprehenisive master document where the other docs created will be briefly described and linked. There will be more PM style docs like some coding standards, feature specs with user stories and implementation plan, etc. The master doc will tell the story of the whole projects, and then link to the other pages.

I just had a thought that we could eventually have a https://wiki.iranti.dev where these pages can all be stored or something.

## General Idea of How Iranti Should Work

### The Definition
Iranti should be a memory management system for AI coding agents, no matter the agent host (e.g. Claude Code, Codex, etc), no matter the interface (e.g. CLI, IDE Extension, desktop app), and session (new vs existing).

It kinda makes sense to eventually expand to other ways users an benefit from Iranti, like storing information in and from the regular web LLMs, creating a cloud platform, etc.

### Mental Image of How it Works
We are thinking of Agents as workers in a library. Each one has work to do given to them by their boss, the User. 

Let's say each Agent has a desj that they are working on. The desk has all the files necessary to answer prompts and perform tasks:m the "desk" is the agents' context windows, and as it continues to fill up, the files fall of the desk, and we are no longer able to recover them. This is where Iranti steps in.

The Staff in the Library that makes up Iranti all have a unique purpose:
- **The Attendant:** they essential are responsible for replacing files on the desk. As knowledge is being generated, they immediately retrieve and store the information as durable facts. They make sure that the Agent always has the relevant knowledge to answer a question and respond to a task, but they do this multiple times during a turn. They also don't just store what the Agents are doing or have learnt, but they also store what the User has given the agents: prompts, images, files, the works. They ensure that everything, EVERYTHING, is stored and retrievable in some way.
- **The Librarian:** They are responsible for maintaining and indexing the growing knowledge base, or Library. As time goes on, the Library will grow bigger as new information is added to it. They store information in an organized format, and have a set of rules for how new indexes are created, and informing the Attendants of these rules and how to find the information they are looking for. They are also responsible for reorganizing information like in a brain to ensure that relevant information is more easily retrievable for the relevant context. And sometimes the information that 
- **The Archivist:**

## Feature Ideas with Descriptions and Purpose

## Some things from the first  Iranti that I wasn't quite a fan off

## Some things we should keep in mind while building Iranti, for the sake of future happiness