
"use client";

import { useState } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function sendMessage() {
    const text = input.trim();

    if (!text || loading) return;

    const updatedMessages: Message[] = [
      ...messages,
      { role: "user", content: text },
    ];

    setMessages(updatedMessages);
    setInput("");
    setLoading(true);

    try {
      const response = await fetch(
        "https://krazy.ebramw2013.workers.dev",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: updatedMessages }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "The AI request failed.");
      }

      const answer =
  data.choices?.[0]?.message?.content ??
  data.response ??
  data.result?.response ??
  data.result ??
  "I couldn't generate a response.";

      setMessages([
        ...updatedMessages,
        { role: "assistant", content: answer },
      ]);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Something went wrong.";

      setMessages([
        ...updatedMessages,
        {
          role: "assistant",
          content: `Sorry, I couldn't get a response. ${errorMessage}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#101114",
        color: "#f5f5f5",
        fontFamily: "Arial, sans-serif",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: "20px",
          borderBottom: "1px solid #303137",
          fontSize: "22px",
          fontWeight: "bold",
        }}
      >
        Krazy AI
      </header>

      <section
        style={{
          width: "100%",
          maxWidth: "800px",
          margin: "0 auto",
          padding: "24px 16px",
          boxSizing: "border-box",
          flex: 1,
        }}
      >
        {messages.length === 0 ? (
          <div style={{ textAlign: "center", marginTop: "18vh" }}>
            <h1 style={{ fontSize: "36px" }}>What can I help with?</h1>
            <p style={{ color: "#a5a5ad" }}>
              Ask Krazy AI anything.
            </p>
          </div>
        ) : (
          messages.map((message, index) => (
            <div
              key={index}
              style={{
                margin: "18px 0",
                padding: "16px",
                borderRadius: "12px",
                background:
                  message.role === "user" ? "#25262c" : "#191a1f",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                lineHeight: 1.6,
              }}
            >
              <strong>
                {message.role === "user" ? "You" : "Krazy AI"}
              </strong>
              <p style={{ marginBottom: 0 }}>{message.content}</p>
            </div>
          ))
        )}

        {loading && (
          <p style={{ color: "#a5a5ad" }}>Krazy AI is thinking...</p>
        )}
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void sendMessage();
        }}
        style={{
          width: "100%",
          maxWidth: "800px",
          boxSizing: "border-box",
          margin: "0 auto",
          padding: "16px",
          display: "flex",
          gap: "10px",
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Message Krazy AI..."
          disabled={loading}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "16px",
            borderRadius: "12px",
            border: "1px solid #414249",
            background: "#202126",
            color: "white",
            fontSize: "16px",
          }}
        />

        <button
          type="submit"
          disabled={loading || !input.trim()}
          style={{
            padding: "0 20px",
            borderRadius: "12px",
            border: "none",
            background: "#f5f5f5",
            color: "#111",
            fontWeight: "bold",
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </form>

      <footer
        style={{
          textAlign: "center",
          padding: "0 12px 16px",
          color: "#888992",
          fontSize: "12px",
        }}
      >
        AI responses can make mistakes.
      </footer>
    </main>
  );
}
