# Test-only bridge: execute the unmodified host consumer, without Rails/session/database.
require 'json'
require 'time'
require 'base64'
module JrcBroker
  class Client
    class Error < StandardError; end
  end
end
# Response.rb only needs ActiveSupport's Time.current; no host auth behavior is replaced.
def Time.current = Time.now
require '/consumer/response'
binding_type = Struct.new(:integration_id, :inbox_id, :instance_id)
results = JSON.parse(STDIN.read).map do |input|
  begin
    value = case input.fetch('method')
            when 'health'
              ids = input.fetch('binding')
              JrcBroker::Response.health(input.fetch('value'), binding_type.new(*ids.values_at('integrationId', 'inboxId', 'instanceId')))
            when 'mutation'
              ids = input.fetch('binding')
              JrcBroker::Response.mutation(input.fetch('value'), binding_type.new(*ids.values_at('integrationId', 'inboxId', 'instanceId')))
            when 'pair_operation'
              JrcBroker::Response.pair_operation(input.fetch('value'), input.fetch('operationId'))
            else
              raise 'UNKNOWN_FIXTURE_METHOD'
            end
    { ok: true, value: value }
  rescue JrcBroker::Client::Error => error
    { ok: false, code: error.message }
  end
end
STDOUT.write(JSON.generate(results))
