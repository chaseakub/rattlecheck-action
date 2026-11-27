# RattleCheck for Supabase Migrations

Check a Supabase pull request for database permission mistakes before merge. For example, a directory can be public by design while a table-wide read grant also exposes a private email column. [See the before-and-after example](https://chaseakub.github.io/rattlecheck/column-permissions/).

## Install

Save this workflow as `.github/workflows/rattlecheck.yml` in a repository with `supabase/migrations/`. The next pull request gets a **rattlecheck** job.

```yaml
name: Supabase migration review
on: pull_request
permissions:
  contents: read

jobs:
  rattlecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - uses: chaseakub/rattlecheck-action@v1
```

[Download the workflow](https://raw.githubusercontent.com/chaseakub/rattlecheck-action/v1/examples/rattlecheck.yml) · [RattleCheck CLI and rules](https://github.com/chaseakub/rattlecheck)

For a monorepo, set `working-directory` on the RattleCheck step to the project folder containing `supabase/migrations/`.

## Read the check

See the [failed run with the table-wide grant](https://github.com/chaseakub/rattlecheck/actions/runs/45845966343) and the [passing run after narrowing it](https://github.com/chaseakub/rattlecheck/actions/runs/45846092556) on the same pull request.

High and critical findings with a source location get a file-and-line annotation. Open the workflow run summary to see the checked objects, scanner version and findings. The Action reads the migration history on the PR branch locally on the runner. A finding can come from an earlier migration. A high or critical finding fails the check. Warnings alone pass. Missing or uncheckable input fails so an empty scan cannot pass as a clean review.

The Action runs on GitHub-hosted Ubuntu with read access to the checkout. It fetches the current stable scanner from npm (`rattlecheck@latest`) on each run. The `v1` tag versions the Action wrapper. No Supabase credentials, GitHub write permissions or external report service are needed.

For an existing project, the [migration PR action](./review-pr/action.yml) compares the proposed merge to its base with one scanner install. The default is `rattlecheck@latest`. To keep the scanner fixed between runs, set the `rattlecheck-version` input to an exact stable npm version and pin the Action to its full commit SHA. The Action checks out the PR itself and annotates new or worsened high and critical findings. Its inputs support a separate migration history or extra migrations that an installer copies onto the main history.

If you used this on an open migration PR, [tell us whether it changed what you shipped](https://github.com/chaseakub/rattlecheck/issues/new?template=migration-review.yml).
