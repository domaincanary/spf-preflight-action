# DomainCanary SPF pre-flight

Fail a pull request when a change to your SPF record would stop a sender that still sends mail
from passing SPF. It's for teams that keep DNS in a repository: DNSControl, octoDNS, Terraform or
a plain file.

The action sends the proposed record to [DomainCanary](https://domaincanary.com/),
which resolves both the published record and the proposed one and compares them.

- **Without an API key** it checks syntax, the 10-lookup limit, a `+all` ending, and which
  addresses the change removes. A removed range is a warning, because there's no way to tell
  from DNS alone whether anything still sends from it.
- **With an API key** it also checks each removed range against the senders in your DMARC reports
  from the last 90 days, and fails the check when one of them sent mail. The domain has to be
  verified in your DomainCanary account. Keys work on every plan, including the free plan;
  create one at <https://domaincanary.com/dashboard/account#api-key>.

## Usage

```yaml
on:
  pull_request:
    paths: ["dns/**"]

jobs:
  spf:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # only for comment: true
    steps:
      - uses: actions/checkout@v4
      - id: record
        run: echo "spf=$(cat dns/spf.txt)" >> "$GITHUB_OUTPUT"
      - uses: domaincanary/spf-preflight-action@v1
        with:
          domain: example.com
          record: ${{ steps.record.outputs.spf }}
          api-key: ${{ secrets.DOMAINCANARY_API_KEY }}
          comment: true
```

| Input | Required | Default | |
| --- | --- | --- | --- |
| `domain` | yes | | The domain the record is for. |
| `record` | yes | | The proposed record, starting with `v=spf1`. Quoted chunks as a DNS panel shows them are fine. |
| `api-key` | no | | A DomainCanary API key. Store it as a secret. |
| `comment` | no | `false` | Post the result as a pull request comment. Needs `pull-requests: write`. |
| `fail-on-warn` | no | `false` | Fail on a warning as well as on an error. |

The `verdict` output is `pass`, `warn`, `fail` or `unchanged`. The check fails on `fail`, and on
any answer other than a verdict (the service unreachable, a rate limit, a revoked key), so a
problem on our side never turns into a green check.

The key belongs to your whole account. If a public repository's secret ever leaks, revoke it from
the account page and create a new one.

## Getting the proposed record out of your DNS tool

The action takes the record as text and doesn't read any tool's files. Add a step before it that
prints the proposed record for the domain's root name. Each recipe below searches the tool's output
for a string starting with `v=spf1` rather than relying on field names, which change between tool
versions. The `jq` parts were checked against sample output; none of the recipes has yet been run
against a real repository, so check the output once before relying on it.

**octoDNS** (with [yq](https://github.com/mikefarah/yq), on the zone file you changed)

```sh
yq '.[""] | .. | select(tag == "!!str") | select(test("^v=spf1"))' zones/example.com.yaml
```

**DNSControl**

```sh
dnscontrol print-ir 2>/dev/null \
  | jq -r --arg zone example.com '.. | objects | select(.name? == $zone and has("records"))
      | .records[] | select(.name == "@" or .name == $zone or .name == ($zone + "."))
      | .. | strings | select(startswith("v=spf1"))' | sort -u
```

If you use `SPF_BUILDER`, this prints the record it builds, split across names when it is long;
the check needs the root record, which is the first one.

**Terraform** (Cloudflare `content` or `value`, Route 53 `records`, and most other providers)

```sh
terraform show -json plan.out \
  | jq -r --arg name example.com '.resource_changes[].change.after
      | select(. != null and .name == $name) | .. | strings | select(test("^\"?v=spf1"))'
```

Some providers want the full name with a trailing dot, or `@`, in `name`; match whatever your
resources use.

**A plain file**

```sh
cat dns/spf.txt
```

## Pull requests from forks

GitHub withholds secrets from workflows that run on pull requests from forks, so on a fork's pull
request the action runs without a key: it checks syntax, lookups and removed addresses, and any
removal is a warning. That is the safe default.

Don't switch to `pull_request_target` to get the key into those runs. That event runs with your
secrets, and checking out the fork's code under it hands them to whoever opened the pull request.

## GitLab, Bitbucket and anything else

The action is a thin wrapper around one HTTP call:

```sh
curl -s -X POST https://domaincanary.com/api/v1/spf-preflight \
  -H "Authorization: Bearer $DOMAINCANARY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com", "record": "v=spf1 include:_spf.google.com -all"}'
```

## Development

```sh
deno test --no-config tests/
```

MIT licensed.
