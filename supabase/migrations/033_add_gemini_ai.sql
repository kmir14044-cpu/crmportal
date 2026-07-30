-- Add Google Gemini as a chat provider and as an optional embeddings provider.
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS embeddings_provider text NOT NULL DEFAULT 'openai';

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_embeddings_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_embeddings_provider_check
  CHECK (embeddings_provider IN ('openai', 'gemini'));
