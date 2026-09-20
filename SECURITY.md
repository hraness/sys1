# Security

Sys1's boundary is small: a loopback HTTP endpoint that forwards
schema-validated System One requests to configured backends. The things that
must not cross it — the hosted credential reaching anywhere but the
configured `base_url`, request or answer bodies landing in logs or durable state,
a listener escaping loopback, a model bypassing SHA-256/GGUF/store admission,
an immutable release carrying bytes other than the checked artifact, or input
exceeding its documented bounds — are the issues we want reported.

The network listener accepts loopback request authorities only, checks Host
against that authority, rejects Origin and browser Sec-Fetch-Site headers, and
requires `application/json` for decision POSTs. It does not enable CORS or a
browser UI. These checks block browser-originated decision dispatch and DNS
rebinding; they are not authentication for local processes. Health and model
discovery do not require authentication. A native process on the same
machine can use every backend the gateway has enabled, including hosted
credentials. Embedded handlers have no network listener and rely on their
owning application's admission policy.

Local GGUF workers receive requests through private pipes. Request bodies,
credentials, answers, and prompts are not application logs or durable state.
Unsupported legacy model inventories fail closed without deleting files or
rewriting the manifest.

## Reporting

Open a private security advisory on the GitHub repository
(`hraness/sys1`, Security → Advisories) or email the maintainers through
the contact listed on the organization profile. Please include a minimal
reproduction or test that demonstrates the issue where possible.

Do not open a public issue for an unpatched vulnerability.
