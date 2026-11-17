#!/usr/bin/env bash
set -euo pipefail
[[ ${RAILS_ENV:-} == test && ${HISTORY_LAB_MODE:-} == true && ${HISTORY_LAB_CI:-} == true ]]
[[ ${POSTGRES_DATABASE:-} == jrc_history_order_test ]]
[[ ${STORAGE_ENDPOINT:-} == http://jrc-history-v2-e2e-minio-20261112:9000 ]]
[[ ${STORAGE_BUCKET_NAME:-} == synthetic-jrc-history-20261112 ]]
cd /testapp
cp /evidence/history-rails-initializer.rb config/initializers/zz_history_lab.rb
mkdir -p tmp log
# Disposable Redis only; no application schedule is registered in this harness.
printf '{}\n' > config/schedule.yml
case ${1:-} in
  schema)
    bundle exec rails db:schema:load
    exec bundle exec rails runner /evidence/prepare-storage.rb
    ;;
  rails) exec bundle exec rails server -b 0.0.0.0 -p 3000 ;;
  sidekiq) exec bundle exec sidekiq -e test -q low -c 1 ;;
  *) echo 'Unknown isolated laboratory process' >&2; exit 64 ;;
esac
