# Isolated regression: real LAB2 policy/control/response, in-memory repository ports.
# This deliberately does not boot Rails or exercise ActiveRecord, authentication or TLS.
require 'json'
require 'time'
require 'base64'
RubyVM::InstructionSequence.compile_file('/request_spec.rb')

module JrcBroker; end
def Time.current = Time.now

class SyntheticRows
  @@query_cache = {}
  @@uncached_depth = 0
  class << self
    attr_accessor :rows

    def exists?(criteria)
      key = [name, criteria]
      return @@query_cache[key] if @@uncached_depth.zero? && @@query_cache.key?(key)

      result = rows.any? { |row| criteria.all? { |field, value| row.fetch(field) == value } }
      @@query_cache[key] = result if @@uncached_depth.zero?
      result
    end

    def uncached
      @@uncached_depth += 1
      yield
    ensure
      @@uncached_depth -= 1
    end

    def clear_query_cache = @@query_cache.clear
  end
end

class AccountUser < SyntheticRows
  attr_reader :id
  def initialize(administrator) = (@id, @administrator = 41, administrator)
  def present? = true
  def reload = self
  def administrator? = @administrator
end
class InboxMember < SyntheticRows; end
class JrcBrokerInboxGrant < SyntheticRows; end
class JrcBrokerInboxBinding < SyntheticRows
  attr_reader :id, :account_id, :inbox_id, :integration_id, :instance_id
  def initialize(row)
    row.each { |key, value| instance_variable_set("@#{key}", value) }
  end
end
User = Struct.new(:id)
SyntheticAccount = Struct.new(:id, :active) do
  def active? = active
  def reload = self
end

require '/consumer/application_policy'
require '/consumer/client'
require '/consumer/access'
require '/consumer/response'
require '/consumer/jrc_broker_policy'
require '/consumer/control'

tests = []
def verify(name, tests)
  yield
  tests << { name: name, passed: true }
rescue StandardError => error
  tests << { name: name, passed: false, error: error.message }
end

row = { id: 7, account_id: 11, inbox_id: 13, integration_id: 'integration-old', instance_id: 'instance-old' }
challenge = { 'operationId' => 'operation-one', 'state' => 'SUCCEEDED', 'reconciliationRequired' => false,
              'action' => { 'type' => 'PAIRING_CODE', 'code' => 'SYNTHETIC', 'expiresAt' => (Time.now + 60).iso8601 } }

[false, true].each do |administrator|
  role = administrator ? 'administrator' : 'agent'
  scenarios = {
    unchanged: row,
    removed: nil,
    recreated: row.merge(id: 8),
    other_account: row.merge(account_id: 12),
    other_inbox: row.merge(inbox_id: 14),
    replaced_integration: row.merge(integration_id: 'integration-new'),
    replaced_instance: row.merge(instance_id: 'instance-new'),
    pairing_grant_removed: row,
    inbox_member_removed: row,
    account_member_removed: row
  }
  scenarios.each do |scenario, current_row|
    verify("#{role}: #{scenario} binding during pairing progress", tests) do
      SyntheticRows.clear_query_cache
      AccountUser.rows = [{ id: 41, account_id: 11, user_id: 31 }]
      InboxMember.rows = [{ inbox_id: 13, user_id: 31 }]
      # Keep grant and membership intact to isolate revocation of the binding itself.
      JrcBrokerInboxGrant.rows = [{ account_id: 11, inbox_id: 13, user_id: 31, can_pair: true }]
      JrcBrokerInboxBinding.rows = [row.dup]
      remote_calls = 0
      client = Object.new
      client.define_singleton_method(:pair_operation) do |_integration_id, _operation_id|
        remote_calls += 1
        JrcBrokerInboxBinding.rows = current_row ? [current_row.dup] : []
        JrcBrokerInboxGrant.rows = [] if scenario == :pairing_grant_removed
        InboxMember.rows = [] if scenario == :inbox_member_removed
        AccountUser.rows = [] if scenario == :account_member_removed
        challenge
      end
      control = JrcBroker::Control.new(account: SyntheticAccount.new(11, true), user: User.new(31),
                                       account_user: AccountUser.new(administrator), binding: JrcBrokerInboxBinding.new(row))
      control.instance_variable_set(:@context, Struct.new(:client).new(client))
      begin
        result = control.pair_operation(operation_id: 'operation-one')
        admin_without_agent_grant = administrator && [:pairing_grant_removed, :inbox_member_removed].include?(scenario)
        raise 'OBSOLETE_CHALLENGE_RELEASED' unless scenario == :unchanged || admin_without_agent_grant
        raise 'CURRENT_CHALLENGE_MISSING' unless result.dig('action', 'code') == 'SYNTHETIC'
      rescue JrcBroker::Client::Error => error
        raise unless scenario != :unchanged && error.status == 403 && error.message == 'JRC_BROKER_FORBIDDEN'
      end
      raise 'PROGRESS_REQUEST_NOT_EXERCISED' unless remote_calls == 1
    end
  end
end

STDOUT.write(JSON.pretty_generate({ scope: 'isolated actual LAB2 Ruby policy/control; repository ports synthetic',
                                  tests: tests.length, failed: tests.count { |test| !test[:passed] }, results: tests }) + "\n")
exit(tests.all? { |test| test[:passed] } ? 0 : 1)
