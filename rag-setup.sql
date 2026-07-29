-- ============================================================
-- AutoBiz AI — Supabase pgvector RAG Setup
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- Step 1: Enable the vector extension (one-time, per project)
CREATE EXTENSION IF NOT EXISTS vector;


-- Step 2: Add embedding column to products table
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS embedding vector(768);
-- 768 dimensions = Gemini text-embedding-004 output size
-- If using OpenAI text-embedding-3-small, change to vector(1536)


-- Step 3: Add embedding to business FAQs (stored as separate table for vector search)
CREATE TABLE IF NOT EXISTS faq_embeddings (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  embedding   vector(768),
  created_at  TIMESTAMPTZ DEFAULT now()
);


-- Step 4: Conversation summaries table (for session memory)
CREATE TABLE IF NOT EXISTS conversation_summaries (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  business_id     TEXT NOT NULL,
  summary         TEXT NOT NULL,
  cart_items      JSONB DEFAULT '[]',
  order_step      INTEGER DEFAULT 0,
  detected_lang   TEXT DEFAULT 'english',
  message_count   INTEGER DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_summaries_conv_id
  ON conversation_summaries(conversation_id);


-- Step 5: Create the vector search function for products
-- This is the function your Node.js backend calls via supabase.rpc()
CREATE OR REPLACE FUNCTION match_products(
  query_embedding vector(768),
  business_id_param TEXT,
  match_count INT DEFAULT 5,
  min_similarity FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id          TEXT,
  name        TEXT,
  price       NUMERIC,
  stock       INTEGER,
  category    TEXT,
  description TEXT,
  similarity  FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.name,
    p.price,
    p.stock,
    p.category,
    p.description,
    1 - (p.embedding <=> query_embedding) AS similarity
  FROM products p
  WHERE
    p.business_id = business_id_param
    AND p.embedding IS NOT NULL
    AND 1 - (p.embedding <=> query_embedding) > min_similarity
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


-- Step 6: Vector search function for FAQs
CREATE OR REPLACE FUNCTION match_faqs(
  query_embedding vector(768),
  business_id_param TEXT,
  match_count INT DEFAULT 3,
  min_similarity FLOAT DEFAULT 0.4
)
RETURNS TABLE (
  question    TEXT,
  answer      TEXT,
  similarity  FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    f.question,
    f.answer,
    1 - (f.embedding <=> query_embedding) AS similarity
  FROM faq_embeddings f
  WHERE
    f.business_id = business_id_param
    AND f.embedding IS NOT NULL
    AND 1 - (f.embedding <=> query_embedding) > min_similarity
  ORDER BY f.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


-- Step 7: Create HNSW index for fast approximate nearest-neighbour search
-- Run this AFTER you've embedded at least some products (index needs data)
-- cosine distance = best for text embeddings
CREATE INDEX IF NOT EXISTS products_embedding_idx
  ON products
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS faq_embedding_idx
  ON faq_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
