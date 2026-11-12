# Executed only inside the identified disposable Rails fixture.
raise 'Synthetic history fixture required' unless Rails.env.test? && ENV['HISTORY_LAB_MODE'] == 'true' &&
                                                ENV['STORAGE_ENDPOINT'] == 'http://jrc-history-v2-e2e-minio-20261112:9000' &&
                                                ENV['STORAGE_BUCKET_NAME'] == 'synthetic-jrc-history-20261112'
storage = ActiveStorage::Blob.services.fetch('s3_compatible')
raise 'Dedicated test bucket required' unless storage.bucket.name == 'synthetic-jrc-history-20261112'
begin
  storage.bucket.create unless storage.bucket.exists?
rescue Aws::S3::Errors::BucketAlreadyOwnedByYou
  # Concurrent test executors may observe the same empty temporary bucket.
end
puts 'Synthetic private Rails bucket verified'
