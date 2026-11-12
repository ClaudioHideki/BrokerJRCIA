#!/bin/sh
set -eu
test "$RAILS_ENV" = test
test "$HISTORY_LAB_MODE" = true
mkdir -p /testapp
tar -xf /evidence/rails-current.tar -C /testapp
cp /evidence/history-rails-initializer.rb /testapp/config/initializers/zz_history_lab.rb
sed -i 's/\r$//' /testapp/bin/rails
cd /testapp
mkdir -p tmp log
exec bundle exec rails server -b 0.0.0.0 -p 3000
