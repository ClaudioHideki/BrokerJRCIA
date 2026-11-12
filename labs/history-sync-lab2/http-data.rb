# Test-only Rack fixture endpoint, copied only to the isolated laboratory.
raise 'Not an isolated history laboratory' unless Rails.env.test? && ENV['HISTORY_LAB_MODE'] == 'true' &&
                                                ActiveRecord::Base.connection_db_config.database == 'jrc_history_order_test'
class HistoryLabData
  def self.seed(scopes)
    raise ArgumentError unless scopes.is_a?(Array) && scopes.size == 2

    prior = ActiveJob::Base.queue_adapter
    ActiveJob::Base.queue_adapter = :test
    scopes.map do |scope|
      account = FactoryBot.create(:account)
      account.enable_features!('jrc_broker')
      admin = FactoryBot.create(:user, account: account, role: :administrator)
      agent = FactoryBot.create(:user, account: account, role: :agent)
      inbox = FactoryBot.create(:channel_api, account: account).inbox
      FactoryBot.create(:inbox_member, inbox: inbox, user: agent)
      JrcBrokerIntegration.create!(account: account, organization_id: scope.fetch('organizationId'), broker_origin: 'https://synthetic.example.test',
                                   destination_revision: 1, encrypted_control_key: 'synthetic-unused-control')
      JrcBrokerInboxBinding.create!(account: account, inbox: inbox, integration_id: scope.fetch('integrationId'), instance_id: scope.fetch('instanceId'))
      { accountId: account.id, inboxId: inbox.id, adminToken: admin.access_token.token, agentToken: agent.access_token.token }
    end
  ensure
    ActiveJob::Base.queue_adapter = prior if prior
  end

  def self.verify(accounts)
    raise ArgumentError unless accounts.is_a?(Array) && accounts.size == 2 && accounts.all? { |id| id.is_a?(Integer) && id.positive? }
    raise ArgumentError unless JrcBrokerIntegration.where(account_id: accounts, broker_origin: 'https://synthetic.example.test').count == 2

    receipts = JrcBrokerHistoryReceipt.where(account_id: accounts, record_kind: 'MESSAGE')
    messages = Message.where(id: receipts.select(:message_id))
    attachments = Attachment.where(message_id: messages.select(:id))
    { messages: messages.count, attachments: attachments.count,
      byte_hashes: attachments.order(:id).map { |a| Digest::SHA256.hexdigest(a.file.download) },
      message_facts: receipts.map do |receipt|
        message = Message.find(receipt.message_id)
        { broker_message_id: receipt.source_id, provider_message_id: message.content_attributes.fetch('jrc_broker_provider_message_id'),
          content: message.content, direction: message.message_type, occurred_at: message.created_at.to_i }
      end,
      all_resolved: messages.all? { |m| m.conversation.resolved? }, all_unassigned: messages.all? { |m| m.conversation.assignee_id.nil? } }
  end

  def self.call(env)
    expected = ENV.fetch('HISTORY_LAB_HTTP_KEY')
    return [403, {}, []] unless expected.bytesize == 64 && ActiveSupport::SecurityUtils.secure_compare(expected, env['HTTP_X_HISTORY_LAB_KEY'].to_s)
    return [403, {}, []] unless env['REQUEST_METHOD'] == 'POST' && env['HTTP_HOST'] == '127.0.0.1:54141'

    body = env.fetch('rack.input').read(16_385)
    return [413, {}, []] if body.bytesize > 16_384

    input = JSON.parse(body)
    result = env['SCRIPT_NAME'].end_with?('/seed') ? seed(input) : verify(input)
    [200, { 'content-type' => 'application/json', 'cache-control' => 'no-store' }, [JSON.generate(result)]]
  rescue ArgumentError, JSON::ParserError
    [400, {}, []]
  end
end
