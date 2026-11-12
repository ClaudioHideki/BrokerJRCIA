#!/bin/sh
set -eu
test "$RAILS_ENV" = test
test "$HISTORY_LAB_MODE" = true
mkdir -p /testapp
tar -xf /evidence/rails-current.tar -C /testapp
cp /evidence/history-rails-initializer.rb /testapp/config/initializers/zz_history_lab.rb
# This synthetic worker consumes ONLY the media queue. No application cron or
# aggregated maintenance routine is registered in the disposable Redis.
printf '{}\n' > /testapp/config/schedule.yml
cd /testapp
mkdir -p tmp log
exec bundle exec sidekiq -e test -q low -c 1
