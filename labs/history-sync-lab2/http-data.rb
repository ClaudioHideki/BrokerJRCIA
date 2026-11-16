# Test-only Rack fixture endpoint, copied only to the isolated laboratory.
raise 'Not an isolated history laboratory' unless Rails.env.test? && ENV['HISTORY_LAB_MODE'] == 'true' &&
                                                %w[jrc_history_order_test jrc_delivery_e2e_test].include?(ActiveRecord::Base.connection_db_config.database)
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
      { accountId: account.id, inboxId: inbox.id, agentId: agent.id, adminToken: admin.access_token.token, agentToken: agent.access_token.token }
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

  def self.outbound_read(input)
    keys = %w[protocol accountId messageId]
    raise ArgumentError unless input.is_a?(Hash) && input.keys.sort == keys.sort && input['protocol'] == 'outbound-read/v1' &&
                               input.values_at('accountId', 'messageId').all? { |id| id.is_a?(Integer) && id.positive? }
    raise ArgumentError unless JrcBrokerIntegration.exists?(account_id: input['accountId'], broker_origin: 'https://synthetic.example.test')

    message = Message.find_by(id: input['messageId'], account_id: input['accountId'], private: false)
    obligation = message && JrcBrokerWebhookObligation.find_by(message_id: message.id, account_id: message.account_id, inbox_id: message.inbox_id)
    raise ArgumentError unless obligation && obligation.current_binding? && JrcBrokerWebhookObligation.deliverable_message?(message)

    { protocol: 'outbound-read/v1',
      message: { id: message.id, inboxId: message.inbox_id, conversationId: message.conversation.display_id,
                 status: message.status, contentAttributes: message.content_attributes },
      delivery: { id: obligation.delivery_id, state: obligation.state, integrationId: obligation.integration_id,
                  instanceId: obligation.instance_id, inboxId: obligation.inbox_id },
      callback: obligation.payload }
  end

  def self.attachment_read(input)
    keys = %w[protocol accountId messageId]
    raise ArgumentError unless input.is_a?(Hash) && input.keys.sort == keys.sort && input['protocol'] == 'attachment-read/v1' &&
                               input.values_at('accountId', 'messageId').all? { |id| id.is_a?(Integer) && id.positive? }
    raise ArgumentError unless JrcBrokerIntegration.exists?(account_id: input['accountId'], broker_origin: 'https://synthetic.example.test')

    message = Message.find_by(id: input['messageId'], account_id: input['accountId'], private: false, message_type: :incoming)
    raise ArgumentError unless message && message.inbox.api? && JrcBrokerInboxBinding.exists?(account_id: message.account_id, inbox_id: message.inbox_id)

    attachments = message.attachments.order(:id).includes(file_attachment: :blob).to_a
    raise ArgumentError unless attachments.any? && attachments.all? { |attachment| attachment.file.attached? }

    { protocol: 'attachment-read/v1', byteHashes: attachments.map { |attachment| Digest::SHA256.hexdigest(attachment.file.download) },
      filenames: attachments.map { |attachment| attachment.file.filename.to_s },
      message: { id: message.id, inboxId: message.inbox_id, conversationId: message.conversation.display_id, content: message.content } }
  end

  def self.native_read(input)
    keys = %w[protocol accountId brokerMessageId]
    raise ArgumentError unless input.is_a?(Hash) && input.keys.sort == keys.sort && input['protocol'] == 'native-read/v1' &&
                               input['accountId'].is_a?(Integer) && input['accountId'].positive? &&
                               input['brokerMessageId'].to_s.match?(/\A[0-9a-f-]{36}\z/)
    raise ArgumentError unless JrcBrokerIntegration.exists?(account_id: input['accountId'], broker_origin: 'https://synthetic.example.test')

    receipt = JrcBrokerLiveReceipt.find_by!(account_id: input['accountId'], broker_message_id: input['brokerMessageId'])
    message = receipt.message
    attachments = message ? message.attachments.order(:id).to_a : []
    { protocol: 'native-read/v1', receipt: receipt.receipt_payload,
      publishedAt: receipt.published_at&.to_i,
      stagedBytes: receipt.staged_bytes&.bytesize,
      messages: Message.where(account_id: receipt.account_id, inbox_id: receipt.inbox_id)
                       .where("content_attributes->>'jrc_broker_message_id'=?", receipt.broker_message_id.to_s).count,
      outboundObligations: message ? JrcBrokerWebhookObligation.where(account_id: receipt.account_id, inbox_id: receipt.inbox_id, message_id: message.id).count : 0,
      byteHashes: attachments.map { |attachment| Digest::SHA256.hexdigest(attachment.file.download) },
      message: message && { id: message.id, inboxId: message.inbox_id, conversationId: message.conversation.display_id,
                            content: message.content, occurredAt: message.created_at.to_i,
                            lastActivityAt: message.conversation.last_activity_at.to_i } }
  end

  def self.call(env)
    expected = ENV.fetch('HISTORY_LAB_HTTP_KEY')
    return [403, {}, []] unless expected.bytesize == 64 && ActiveSupport::SecurityUtils.secure_compare(expected, env['HTTP_X_HISTORY_LAB_KEY'].to_s)
    return [403, {}, []] unless env['REQUEST_METHOD'] == 'POST' && env['HTTP_HOST'] == '127.0.0.1:54141'

    body = env.fetch('rack.input').read(16_385)
    return [413, {}, []] if body.bytesize > 16_384

    input = JSON.parse(body)
    result = case env['SCRIPT_NAME'].split('/').last
             when 'seed' then seed(input)
             when 'verify' then verify(input)
             when 'outbound-read' then outbound_read(input)
             when 'attachment-read' then attachment_read(input)
             when 'native-read' then native_read(input)
             else raise ArgumentError
             end
    [200, { 'content-type' => 'application/json', 'cache-control' => 'no-store' }, [JSON.generate(result)]]
  rescue ArgumentError, JSON::ParserError
    [400, {}, []]
  end
end
