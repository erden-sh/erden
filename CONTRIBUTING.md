# Contributing

Thank you for your interest in Erden.

We are not accepting outside contributions at this time: pull requests from outside the project will be closed
without review. This keeps the code under a single copyright holder while the project takes shape, and we may open up
later.

We do want to hear from you. Please open an issue for a bug, a question, a missing feature or anything that got in
your way, or reach out through the contact details on the GitHub profile of the repository's owner. To report a
security problem, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Commits

Every commit in this repository's history is checked, on pull requests and on `main`
(`node scripts/audit-open-tree.mjs . --history --no-containers`):

- Commit with your GitHub no-reply address, `<id>+<login>@users.noreply.github.com`, as both author and committer. You
  can find it in your GitHub email settings. Any name is fine.
- End the message with its last paragraph of prose, not with trailers such as `Co-authored-by:` or `Signed-off-by:`, and
  don't link tool or agent sessions in it.
