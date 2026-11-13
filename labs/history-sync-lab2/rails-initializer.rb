# Copied ONLY into the disposable Rails HTTP/Sidekiq laboratory, never a product initializer.
raise 'History laboratory requires Rails test and explicit opt-in' unless Rails.env.test? && ENV['HISTORY_LAB_MODE'] == 'true'

# Rails can reload ActiveStorage classes between requests. Preserve the shared
# private service in configuration as well as on the initial Blob class.
Rails.application.config.active_storage.service = :s3_compatible
Rails.application.config.after_initialize do
  ActiveStorage::Blob.service = ActiveStorage::Blob.services.fetch('s3_compatible')
  ActiveJob::Base.queue_adapter = :sidekiq
  unless Sidekiq.server?
    ENV['HISTORY_LAB_HTTP_KEY'] ||= Digest::SHA256.hexdigest('synthetic-history-http:' + ENV.fetch('JRC_BROKER_CREDENTIAL_KEY'))
    require '/evidence/history-http-data'
    Rails.application.routes.prepend do
      mount HistoryLabData => '/__history_lab/seed', as: 'history_lab_seed'
      mount HistoryLabData => '/__history_lab/verify', as: 'history_lab_verify'
    end
  end
end
