---
name: people-lookup
description: Resolve a person named in a request to the exact email address, chat handle or meeting attendee an operation needs, before any send, draft, reply, forward, invite, share or directory call. Looks in memory first, then the owner's own mail threads and contacts, then a directory the owner can read. Never constructs or guesses an address; remembers what it finds and where it was found, so the next request needs no search.
applicability:
  toolFamilies: [email, mail, message, chat, calendar, meeting, invite, contacts, directory, share]
  entitySlots: [person, people, recipient, contact, attendee, colleague, teammate, address, email address, handle]
---

# People lookup

When a request names a person and the work needs that person's address (an email recipient, a chat handle, a meeting attendee, a share target), resolve it before the operation that needs it. Work through the sources below in order and stop at the first one that answers.

## 1. Memory first

Search memory for the person by name: `memory_search_facts` with the name as the query, then `memory_recall_all` with the name as the objective only if the first returns nothing. A remembered address that names where it came from is the answer; do not search mail for it again. One search per person per tool; never repeat a memory read with different wording.

## 2. The owner's own correspondence

Search the owner's connected mail account for messages from or to the person by name, sent and received. Find the search operation with `tool_search` by describing the role ("search mail messages by sender or recipient name"), run it once with the person's name, and read the `from` and `to` fields of the matching thread. The address the person actually used is the answer. If the mail search finds nothing, search the contacts of the same account by name. When the request names the account to send from, search that account.

## 3. A directory the owner can read

If the owner's own mail and contacts do not have the person, search a people directory the owner can read (an organization directory, a team roster) by name. A directory lookup keyed on an address you constructed is a guess and is not allowed.

## Rules

- Never construct, infer or try an address: not first.last@domain, not a pattern copied from a colleague's address, not the domain of the owner's own address. An address exists only when a source returned it or the owner typed it.
- When two or more people are named, resolve each one with the same steps: one search per source per person, and search for both people in one call when the operation allows it.
- If nothing resolves after step 3, ask the owner one plain question naming the person ("What is Dana Lee's email address?"). Offer nothing invented, and do not send to a partial list without saying who is missing.
- When a source answers, record it once with `memory_remember` (kind `reference`): "<Full name>'s <work or personal> email address is <address> (from <the source: a message they sent on <date> | the account's contacts | the directory>)", with `entities: [{ "type": "person", "name": "<Full name>", "identifiers": [{ "scheme": "email", "value": "<address>" }] }]`. The next request then resolves it from memory in step 1.
- Before an irreversible send, every recipient must come from one of these sources or from the owner's own words, and the reply says where each address came from.
