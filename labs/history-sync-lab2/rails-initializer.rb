# Copied ONLY into the disposable Rails HTTP/Sidekiq laboratory, never a product initializer.
raise 'History laboratory requires Rails test and explicit opt-in' unless Rails.env.test? && ENV['HISTORY_LAB_MODE'] == 'true'

# Signed attachment routes must refer to the same dedicated loopback HTTP
# consumer used by the end-to-end client, never an unrelated synthetic host.
ENV['FRONTEND_URL'] = 'http://127.0.0.1:54141'

# Rails can reload ActiveStorage classes between requests. Preserve the shared
# private service in configuration as well as on the initial Blob class.
Rails.application.config.active_storage.service = :s3_compatible
Rails.application.config.after_initialize do
  ActiveStorage::Blob.service = ActiveStorage::Blob.services.fetch('s3_compatible')
  ActiveJob::Base.queue_adapter = :sidekiq
  # Capture live outbound jobs in memory. This laboratory never runs an external
  # webhook/send; only the real private-media low queue remains on Sidekiq.
  SendReplyJob.queue_adapter = :test
  WebhookJob.queue_adapter = :test
  JrcBroker::WebhookObligationJob.queue_adapter = :test
  unless Sidekiq.server?
    ENV['HISTORY_LAB_HTTP_KEY'] ||= Digest::SHA256.hexdigest('synthetic-history-http:' + ENV.fetch('JRC_BROKER_CREDENTIAL_KEY'))
    require '/evidence/history-http-data'
    Rails.application.routes.prepend do
      mount HistoryLabData => '/__history_lab/seed', as: 'history_lab_seed'
      mount HistoryLabData => '/__history_lab/verify', as: 'history_lab_verify'
      mount HistoryLabData => '/__history_lab/outbound-read', as: 'history_lab_outbound_read'
      mount HistoryLabData => '/__history_lab/attachment-read', as: 'history_lab_attachment_read'
      mount HistoryLabData => '/__history_lab/native-read', as: 'history_lab_native_read'
    end
  end
end
