// Public ABI subset from ggml-org/llama.cpp f114f91/include/llama.h.
// Copyright (c) 2023-2026 The ggml authors. MIT; see LICENSE.
#pragma once
#include <cstddef>
#include <cstdint>
extern "C" {
struct llama_vocab;
struct llama_sampler;
struct ggml_tensor;
struct ggml_context;
struct ggml_cgraph;
struct ggml_backend_buffer_type;
using ggml_backend_buffer_type_t = ggml_backend_buffer_type *;
using llama_token = int32_t;
struct llama_token_data { llama_token id; float logit; float p; };
struct llama_token_data_array { llama_token_data * data; size_t size; int64_t selected; bool sorted; };
struct llama_sampler_data { ggml_tensor * logits; ggml_tensor * probs; ggml_tensor * sampled; ggml_tensor * candidates; };
struct llama_sampler_i {
    const char * (*name)(const llama_sampler *);
    void (*accept)(llama_sampler *, llama_token);
    void (*apply)(llama_sampler *, llama_token_data_array *);
    void (*reset)(llama_sampler *);
    llama_sampler * (*clone)(const llama_sampler *);
    void (*free)(llama_sampler *);
    bool (*backend_init)(llama_sampler *, ggml_backend_buffer_type_t, uint32_t);
    void (*backend_accept)(llama_sampler *, ggml_context *, ggml_cgraph *, ggml_tensor *);
    void (*backend_apply)(llama_sampler *, ggml_context *, ggml_cgraph *, llama_sampler_data *);
    void (*backend_set_input)(llama_sampler *);
    void (*backend_reset)(llama_sampler *);
    void (*copy_state)(const llama_sampler *, llama_sampler *);
};
struct llama_sampler { llama_sampler_i * iface; void * ctx; };
llama_sampler * llama_sampler_init_dry(const llama_vocab *, float, float, int32_t, int32_t, const char **, size_t);
}
