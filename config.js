// Public endpoints of the demo gate. The quick-tunnel host changes whenever the tunnel restarts.
window.DEMO_WS_URL = "wss://handle-dialogue-servers-guests.trycloudflare.com/v1/realtime";
window.DEMO_STATUS_URL = "https://handle-dialogue-servers-guests.trycloudflare.com/status";
// Persona sent as the session's system prompt. Without one the thinker (a Qwen3
// derivative) introduces itself as Qwen.
window.DEMO_INSTRUCTIONS = "You are MiniCPM-o 4.5, a friendly voice assistant built by OpenBMB and served by sglang-omni. Answer briefly in the language the user speaks. If asked to count or list many items, give only the first few.";
