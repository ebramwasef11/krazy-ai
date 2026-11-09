
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  FormEvent,
  KeyboardEvent,
} from "react";

import type {
  AuthChangeEvent,
  Session,
} from "@supabase/supabase-js";

import styles from "./page.module.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "./lib/supabase";

type Message = {
  role: "user" | "assistant";
  content: string;
  isError?: boolean;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: string;
};

type Personality = "default" | "professional" | "friendly" | "concise";

type AiMode = "flash" | "core" | "think" | "deep" | "omega";

const PERSONALITIES: {
  id: Personality;
  name: string;
  description: string;
  preview: string;
}[] = [
  {
    id: "default",
    name: "Default",
    description: "Casual, funny, confident, and naturally conversational.",
    preview: "Relaxed conversation, playful banter, and personality without forced slang.",
  },
  {
    id: "professional",
    name: "Professional",
    description: "Polished, structured, and professional.",
    preview: "Clear explanations, organized answers, and a more formal tone.",
  },
  {
    id: "friendly",
    name: "Friendly",
    description: "Warm, supportive, and approachable.",
    preview: "Encouraging conversation with a helpful and welcoming tone.",
  },
  {
    id: "concise",
    name: "Straight to the Point",
    description: "Direct answers with minimal filler.",
    preview: "Short, clear responses that focus on what matters.",
  },
];

const WORKER_URL = "https://krazy.ebramw2013.workers.dev";
const OWNER_TOKEN_STORAGE_KEY = "krazy_owner_token_v1";
const REQUEST_TIMEOUT = 90000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_CONVERSATIONS = 100;
const MAX_CUSTOM_INSTRUCTIONS = 1500;

function createId(prefix: string): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function getTitle(messages: Message[]): string {
  const first = messages.find((message) => message.role === "user");
  if (!first) return "New chat";

  const title = first.content.replace(/\s+/g, " ").trim();
  return title.length > 42 ? `${title.slice(0, 42)}…` : title;
}

function cleanConversationMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (message): message is Message =>
        message !== null &&
        typeof message === "object" &&
        ["user", "assistant"].includes((message as Message).role) &&
        typeof (message as Message).content === "string"
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred. Please try again.";
}

function extractChunk(parsed: Record<string, unknown>): string {
  const choices = parsed.choices as
    | Array<Record<string, unknown>>
    | undefined;

  const choice = choices?.[0];
  const delta = choice?.delta as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;

  const candidates = [
    delta?.content,
    message?.content,
    choice?.text,
    parsed.response,
    parsed.output_text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;

    if (Array.isArray(candidate)) {
      const combined = candidate
        .map((part) => {
          if (typeof part === "string") return part;

          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof part.text === "string"
          ) {
            return part.text;
          }

          return "";
        })
        .join("");

      if (combined) return combined;
    }
  }

  return "";
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [authMode, setAuthMode] = useState<
    "login" | "signup" | "forgot" | "reset"
  >("login");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [routeChatId, setRouteChatId] = useState<string | null>(null);
  const [routeReady, setRouteReady] = useState(false);

  const [input, setInput] = useState("");
  const [aiMode, setAiMode] = useState<AiMode>("core");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [hasReceivedFirstChunk, setHasReceivedFirstChunk] = useState(false);

  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [historySearch, setHistorySearch] = useState("");

  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [storageReady, setStorageReady] = useState(false);
  const [ownerMode, setOwnerMode] = useState(false);

  // Personalization state.
  const [activeView, setActiveView] = useState<"chat" | "personalization">("chat");
  const [personality, setPersonality] = useState<Personality>("default");
  const [customInstructions, setCustomInstructions] = useState("");
  const [preferencesLoading, setPreferencesLoading] = useState(false);
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [preferencesMessage, setPreferencesMessage] = useState("");
  const [preferencesError, setPreferencesError] = useState("");

  const requestInProgress = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const syncedIds = useRef<Set<string>>(new Set());
  const syncQueues = useRef<Map<string, Promise<void>>>(new Map());
  const currentSession = useRef<Session | null>(null);
  // Keep the browser URL synchronized with the selected conversation.
function updateChatUrl(chatId: string | null, replace = false) {
  if (typeof window !== "undefined") {
    const nextPath = chatId
      ? `/c/${encodeURIComponent(chatId)}`
      : "/";

    if (window.location.pathname !== nextPath) {
      window.history[replace ? "replaceState" : "pushState"](
        {},
        "",
        nextPath
      );
    }
  }

  setRouteChatId(chatId);
}

// Read conversation URLs and support browser back/forward navigation.
useEffect(() => {
  function syncRoute() {
    const match = window.location.pathname.match(/^\/c\/([^/]+)\/?$/);
    let chatId: string | null = null;

    if (match) {
      try {
        chatId = decodeURIComponent(match[1]);
      } catch {
        chatId = null;
      }
    } else if (window.location.pathname !== "/") {
      window.history.replaceState({}, "", "/");
    }

    setRouteChatId(chatId);
    setRouteReady(true);
  }

  syncRoute();

  window.addEventListener("popstate", syncRoute);

  return () => {
    window.removeEventListener("popstate", syncRoute);
  };
}, []);

  // Supabase authentication.
  useEffect(() => {
    let mounted = true;

    async function loadSession() {
      const { data, error } = await supabase.auth.getSession();

      if (!mounted) return;

      if (error) {
        setAuthError(error.message);
      }

      setSession(data.session);
      currentSession.current = data.session;
      setAuthReady(true);
    }

    void loadSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, nextSession: Session | null) => {
        if (!mounted) return;

        setSession(nextSession);
        currentSession.current = nextSession;
        setAuthMessage("");
        setAuthError("");
      }
    );

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);
  // Restore and verify Owner Mode from this browser.
useEffect(() => {
  const token = localStorage.getItem(OWNER_TOKEN_STORAGE_KEY);

  if (!token) {
    setOwnerMode(false);
    return;
  }

  const ownerToken = token;

  let cancelled = false;

  async function verifyOwnerMode() {
    try {
      const response = await fetch(`${WORKER_URL}/owner/status`, {
        method: "GET",
        headers: {
          "X-Krazy-Owner-Token": ownerToken,
        },
        cache: "no-store",
      });

      const data = await response.json().catch(() => ({}));

      if (cancelled) return;

      if (response.ok && data.active === true) {
        setOwnerMode(true);
      } else {
        localStorage.removeItem(OWNER_TOKEN_STORAGE_KEY);
        setOwnerMode(false);
      }
    } catch {
      if (!cancelled) {
        // Keep the saved token if verification temporarily fails.
        setOwnerMode(false);
      }
    }
  }

  void verifyOwnerMode();

  return () => {
    cancelled = true;
  };
}, []);

  // Send authenticated requests to the Worker.
  async function workerRequest(
    path: string,
    method: string,
    body?: unknown
  ) {
    const activeSession = currentSession.current;

    if (!activeSession) {
      throw new Error("Please sign in again.");
    }

    const response = await fetch(`${WORKER_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${activeSession.access_token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : `The server returned error ${response.status}.`
      );
    }

    return data;
  }

  // Load the signed-in user's personalization preferences.
  useEffect(() => {
    if (!session) {
      setPersonality("default");
      setCustomInstructions("");
      setPreferencesLoading(false);
      setPreferencesMessage("");
      setPreferencesError("");
      return;
    }

    let cancelled = false;

    async function loadPreferences() {
      setPreferencesLoading(true);
      setPreferencesError("");
      setPreferencesMessage("");

      try {
        const data = await workerRequest("/preferences", "GET");

        if (cancelled) return;

        const saved = data.preferences ?? data;

        const validPersonalities: Personality[] = [
          "default",
          "professional",
          "friendly",
          "concise",
        ];

        setPersonality(
          validPersonalities.includes(saved.personality)
            ? saved.personality
            : "default"
        );

        setCustomInstructions(
          typeof saved.customInstructions === "string"
            ? saved.customInstructions.slice(0, MAX_CUSTOM_INSTRUCTIONS)
            : ""
        );
      } catch (error) {
        if (!cancelled) {
          setPreferencesError(
            `Couldn't load your preferences: ${getErrorMessage(error)}`
          );
        }
      } finally {
        if (!cancelled) {
          setPreferencesLoading(false);
        }
      }
    }

    void loadPreferences();

    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  // Save personalization preferences to the account.
  async function savePreferences() {
    if (!session || preferencesSaving || preferencesLoading) return;

    setPreferencesSaving(true);
    setPreferencesMessage("");
    setPreferencesError("");

    try {
      await workerRequest("/preferences", "PUT", {
        personality,
        customInstructions: customInstructions.trim(),
      });

      setPreferencesMessage("Your personalization settings have been saved.");
    } catch (error) {
      setPreferencesError(
        `Couldn't save your preferences: ${getErrorMessage(error)}`
      );
    } finally {
      setPreferencesSaving(false);
    }
  }

  // Load the signed-in user's conversations from Cloudflare D1.
  useEffect(() => {
    if (!session) {
      setConversations([]);
      setMessages([]);
      setActiveChatId(null);
      setStorageReady(false);
      syncedIds.current.clear();
      return;
    }

    const accessToken = session.access_token;

    let cancelled = false;

    async function loadConversations() {
      setStorageReady(false);
      syncedIds.current.clear();

      try {
        const response = await fetch(`${WORKER_URL}/conversations`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          cache: "no-store",
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : "Could not load your conversations."
          );
        }

        const loaded: Conversation[] = Array.isArray(data.conversations)
          ? data.conversations
              .filter(
                (item: unknown) =>
                  item !== null &&
                  typeof item === "object" &&
                  typeof (item as Conversation).id === "string" &&
                  typeof (item as Conversation).title === "string"
              )
              .map((item: Conversation & { updatedAt?: string }) => ({
                id: item.id,
                title: item.title,
                messages: cleanConversationMessages(item.messages),
                updatedAt: item.updatedAt || new Date().toISOString(),
              }))
              .slice(0, MAX_CONVERSATIONS)
          : [];

        if (cancelled) return;

        for (const chat of loaded) {
          syncedIds.current.add(chat.id);
        }

        setConversations(loaded);

        setActiveChatId(null);
        setMessages([]);
      } catch (error) {
        if (!cancelled) {
          setAuthError(getErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setStorageReady(true);
        }
      }
    }

    void loadConversations();

    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);
    // Select the conversation requested by the current URL.
  useEffect(() => {
    if (!routeReady || !storageReady) return;

    if (!routeChatId) {
      setActiveChatId(null);
      setMessages([]);
      return;
    }

    const requestedChat = conversations.find(
      (chat) => chat.id === routeChatId
    );

    if (requestedChat) {
      setActiveChatId(requestedChat.id);
      setMessages(requestedChat.messages);
    } else {
      setActiveChatId(null);
      setMessages([]);
    }
  }, [routeChatId, routeReady, storageReady, conversations]);

  // Keep the newest message visible.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: streaming ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, loading, streaming]);

  // Focus the rename field.
  useEffect(() => {
    if (renamingChatId) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renamingChatId]);

  // Automatically resize the composer.
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [input]);

  // Search titles and message contents.
  const filteredConversations = useMemo(() => {
    const query = historySearch.trim().toLowerCase();

    if (!query) return conversations;

    return conversations.filter(
      (chat) =>
        chat.title.toLowerCase().includes(query) ||
        chat.messages.some((message) =>
          message.content.toLowerCase().includes(query)
        )
    );
  }, [conversations, historySearch]);

  // Queue database updates for each conversation to prevent overlapping writes.
  const queueConversationSync = useCallback(
    (conversation: Conversation) => {
      if (!currentSession.current) return;

      const id = conversation.id;
      const previous = syncQueues.current.get(id) || Promise.resolve();

      const next = previous
        .catch(() => undefined)
        .then(async () => {
          if (!currentSession.current) return;

          const payload = {
            title: conversation.title,
            messages: conversation.messages.map(({ role, content }) => ({
              role,
              content,
            })),
          };

          if (syncedIds.current.has(id)) {
            await workerRequest(
              `/conversations/${encodeURIComponent(id)}`,
              "PATCH",
              payload
            );
          } else {
            await workerRequest("/conversations", "POST", {
              id,
              ...payload,
            });

            syncedIds.current.add(id);
          }
        })
        .catch((error) => {
          console.error("Conversation sync failed:", error);
          setAuthError(
            `Your chat could not be saved to your account: ${getErrorMessage(error)}`
          );
        })
        .finally(() => {
          if (syncQueues.current.get(id) === next) {
            syncQueues.current.delete(id);
          }
        });

      syncQueues.current.set(id, next);
    },
    []
  );

  // Sync changed conversations to the account.
  useEffect(() => {
    if (!storageReady || !session) return;

    const timeout = window.setTimeout(() => {
      for (const chat of conversations) {
        if (chat.messages.length > 0) {
          queueConversationSync(chat);
        }
      }
    }, 700);

    return () => window.clearTimeout(timeout);
  }, [
    conversations,
    session?.access_token,
    storageReady,
    queueConversationSync,
  ]);

  // Update the current conversation.
  const saveConversation = useCallback(
    (chatId: string, nextMessages: Message[]) => {
      setMessages(nextMessages);

      if (nextMessages.length === 0) return;

      setConversations((previous) => {
        const existing = previous.find((chat) => chat.id === chatId);

        const conversation: Conversation = {
          id: chatId,
          title: existing?.title || getTitle(nextMessages),
          messages: nextMessages,
          updatedAt: new Date().toISOString(),
        };

        return [
          conversation,
          ...previous.filter((chat) => chat.id !== chatId),
        ].slice(0, MAX_CONVERSATIONS);
      });
    },
    []
  );

  // Read the response stream from the Cloudflare Worker.
  async function getAnswer(
    history: Message[],
    onChunk: (fullText: string) => void
  ): Promise<string> {
    const controller = new AbortController();

    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT
    );

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const activeSession = currentSession.current;

      if (!activeSession) {
        throw new Error("Please sign in again.");
      }

      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeSession.access_token}`,
          ...(localStorage.getItem(OWNER_TOKEN_STORAGE_KEY) !== null
            ? {
                "X-Krazy-Owner-Token":
                  localStorage.getItem(OWNER_TOKEN_STORAGE_KEY) as string,
              }
            : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          stream: true,
          mode: aiMode,
          personality,
          customInstructions,
          messages: history
            .slice(-MAX_HISTORY_MESSAGES)
            .map(({ role, content }) => ({ role, content })),
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));

        throw new Error(
          typeof data.error === "string"
            ? data.error
            : `The server returned error ${response.status}.`
        );
      }

      if (!response.body) {
        throw new Error("The server did not provide a response stream.");
      }

      reader = response.body.getReader();

      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";

      function processEvent(event: string) {
        const dataLines = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        for (const dataLine of dataLines) {
          if (!dataLine || dataLine === "[DONE]") continue;

          let parsed: Record<string, unknown>;

          try {
            parsed = JSON.parse(dataLine);
          } catch {
            continue;
          }

          if (parsed.error) {
            throw new Error(
              typeof parsed.error === "string"
                ? parsed.error
                : "The AI stream returned an error."
            );
          }

          const chunk = extractChunk(parsed);

          if (chunk) {
            answer += chunk;
            onChunk(answer);
          }
        }
      }

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";

        for (const event of events) {
          processEvent(event);
        }
      }

      buffer += decoder.decode();

      if (buffer.trim()) {
        processEvent(buffer);
      }

      if (!answer.trim()) {
        throw new Error(
          "Krazy AI returned an empty response. Please try again."
        );
      }

      return answer.trim();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("The request took too long. Please try again.");
      }

      if (
        error instanceof TypeError &&
        error.message.toLowerCase().includes("fetch")
      ) {
        throw new Error(
          "Could not connect to Krazy AI. Check your internet connection and try again."
        );
      }

      throw error;
    } finally {
      if (reader) {
        void reader.cancel().catch(() => undefined);
      }

      window.clearTimeout(timeout);
    }
  }

  function resetRequestState() {
    requestInProgress.current = false;
    setLoading(false);
    setStreaming(false);
    setHasReceivedFirstChunk(false);
    inputRef.current?.focus();
  }

  // Send a new message.
  async function sendMessage() {
    const text = input.trim();

    if (
      !text ||
      text.length > MAX_MESSAGE_LENGTH ||
      requestInProgress.current ||
      !storageReady ||
      !session
    ) {
      return;
    }
    // Owner commands. These commands are not saved in chat history.
  const isOwnerCommand =
    text === "/owner" ||
    text.startsWith("/owner ") ||
    [
      "/owneroff",
      "/ownerinfo",
      "/ownerhelp",
      "/ownerstats",
      "/ownerusers",
      "/ownerpersonality",
    ].includes(text.split(/\s+/)[0]);

  if (isOwnerCommand) {
    setInput("");

    // Disable Owner Mode in this browser.
    if (text === "/owneroff") {
      localStorage.removeItem(OWNER_TOKEN_STORAGE_KEY);
      setOwnerMode(false);

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: "Owner Mode has been disabled in this browser.",
        },
      ]);

      return;
    }

    // Activate Owner Mode with the secret code.
    if (text.startsWith("/owner ")) {
      const ownerCode = text.slice(7).trim();

      if (!ownerCode) {
        setMessages((previous) => [
          ...previous,
          {
            role: "assistant",
            content: "Enter your activation code after /owner.",
          },
        ]);
        return;
      }

      requestInProgress.current = true;
      setLoading(true);

      try {
        const response = await fetch(`${WORKER_URL}/owner/activate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code: ownerCode }),
          cache: "no-store",
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || typeof data.token !== "string") {
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : "Owner Mode activation failed."
          );
        }

        localStorage.setItem(OWNER_TOKEN_STORAGE_KEY, data.token);
        setOwnerMode(true);

        setMessages((previous) => [
          ...previous,
          {
            role: "assistant",
            content:
              "Owner Mode activated successfully. Welcome, creator.",
          },
        ]);
      } catch (error) {
        setMessages((previous) => [
          ...previous,
          {
            role: "assistant",
            content: `Owner Mode activation failed: ${getErrorMessage(error)}`,
            isError: true,
          },
        ]);
      } finally {
        resetRequestState();
      }

      return;
    }

    // Show Owner Mode status.
    if (text === "/owner") {
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: ownerMode
            ? "Owner Mode is currently active in this browser."
            : "Owner Mode is currently inactive. Use /owner followed by your activation code to activate it.",
        },
      ]);

      return;
    }

    requestInProgress.current = true;
    setLoading(true);

    try {
      const token = localStorage.getItem(OWNER_TOKEN_STORAGE_KEY);
      const activeSession = currentSession.current;

      if (!token || !activeSession) {
        throw new Error("Verified Owner Mode is required.");
      }

      const accessToken = activeSession.access_token;
      const ownerToken = token;

      // Verify Owner Mode with the Worker.
      const statusResponse = await fetch(`${WORKER_URL}/owner/status`, {
        method: "GET",
        headers: {
          "X-Krazy-Owner-Token": ownerToken,
        },
        cache: "no-store",
      });

      const statusData = await statusResponse.json().catch(() => ({}));

      if (!statusResponse.ok || statusData.active !== true) {
        localStorage.removeItem(OWNER_TOKEN_STORAGE_KEY);
        setOwnerMode(false);
        throw new Error("Owner Mode is inactive or your token is invalid.");
      }

      setOwnerMode(true);

      // Helper for authenticated owner-only Worker endpoints.
      async function ownerRequest(
        path: string,
        method = "GET",
        body?: unknown
      ) {
        const response = await fetch(`${WORKER_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "X-Krazy-Owner-Token": ownerToken,
            ...(body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
          },
          ...(body !== undefined
            ? { body: JSON.stringify(body) }
            : {}),
          cache: "no-store",
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : `Server error ${response.status}.`
          );
        }

        return data;
      }

      let result = "";

      // Creator information.
      if (text === "/ownerinfo") {
        result = [
          "# KRAZY AI — Creator Information",
          "",
          "**Creator:** Ebram Wasef",
          "**Project:** KRAZY AI",
          "**Role:** Founder and creator",
          "**Owner Mode:** Verified",
        ].join("\n");
      }

      // Owner command guide.
      else if (text === "/ownerhelp") {
        result = [
          "# KRAZY AI — Owner Commands",
          "",
          "`/owner` — Check Owner Mode status.",
          "`/owner [code]` — Activate Owner Mode.",
          "`/owneroff` — Disable Owner Mode in this browser.",
          "`/ownerinfo` — Display creator information.",
          "`/ownerhelp` — Display this command guide.",
          "`/ownerstats` — View website statistics.",
          "`/ownerusers` — View saved-user statistics.",
          "`/ownerpersonality` — View global AI personality.",
          "`/ownerpersonality default` — Set Default.",
          "`/ownerpersonality professional` — Set Professional.",
          "`/ownerpersonality friendly` — Set Friendly.",
          "`/ownerpersonality concise` — Set Straight to the Point.",
        ].join("\n");
      }

      // Website statistics.
      else if (text === "/ownerstats") {
        const stats = await ownerRequest("/owner/stats");

        result = [
          "# KRAZY AI — Website Statistics",
          "",
          `**Conversations:** ${stats.totalConversations ?? 0}`,
          `**Messages:** ${stats.totalMessages ?? 0}`,
          `**Saved memories:** ${stats.totalMemories ?? 0}`,
          `**Users with saved data:** ${stats.usersWithSavedData ?? 0}`,
        ].join("\n");
      }

      // Saved-user statistics.
      else if (text === "/ownerusers") {
        const users = await ownerRequest("/owner/users");

        result = [
          "# KRAZY AI — User Statistics",
          "",
          `**Users with saved data:** ${users.usersWithSavedData ?? 0}`,
          `**Users with conversations:** ${users.usersWithConversations ?? 0}`,
          `**Users with preferences:** ${users.usersWithPreferences ?? 0}`,
          `**Users with memories:** ${users.usersWithMemories ?? 0}`,
          "",
          "*These are database activity counts, not total registered Supabase accounts.*",
        ].join("\n");
      }

      // Global Owner Mode personality.
      else if (text === "/ownerpersonality" ||
        text.startsWith("/ownerpersonality ")) {
        const requestedPersonality = text
          .slice("/ownerpersonality".length)
          .trim()
          .toLowerCase();

        const validPersonalities: Personality[] = [
          "default",
          "professional",
          "friendly",
          "concise",
        ];

        if (!requestedPersonality) {
          const data = await ownerRequest("/owner/personality");

          result = `**Global KRAZY AI personality:** ${data.personality ?? "default"}`;
        } else if (
          !validPersonalities.includes(
            requestedPersonality as Personality
          )
        ) {
          result =
            "Invalid personality. Choose: default, professional, friendly, or concise.";
        } else {
          const data = await ownerRequest(
            "/owner/personality",
            "PUT",
            { personality: requestedPersonality }
          );

          result = `Global KRAZY AI personality successfully changed to **${data.personality}**.`;
        }
      } else {
        result = "Unknown Owner Mode command. Type /ownerhelp to see available commands.";
      }

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: result,
        },
      ]);
    } catch (error) {
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: `Owner command failed: ${getErrorMessage(error)}`,
          isError: true,
        },
      ]);
    } finally {
      resetRequestState();
    }

    return;
  }

    requestInProgress.current = true;

    const chatId = activeChatId ?? createId("chat");

    if (!activeChatId) {
      updateChatUrl(chatId);
    }

    const history: Message[] = [
      ...messages,
      { role: "user", content: text },
    ];

    setActiveChatId(chatId);
    setInput("");
    setLoading(true);
    setStreaming(false);
    setHasReceivedFirstChunk(false);

    saveConversation(chatId, [
      ...history,
      { role: "assistant", content: "" },
    ]);

    try {
      const answer = await getAnswer(history, (fullText) => {
        if (!requestInProgress.current) return;

        setStreaming(true);
        setHasReceivedFirstChunk(true);

        saveConversation(chatId, [
          ...history,
          { role: "assistant", content: fullText },
        ]);
      });

      saveConversation(chatId, [
        ...history,
        { role: "assistant", content: answer },
      ]);
    } catch (error) {
      saveConversation(chatId, [
        ...history,
        {
          role: "assistant",
          content: `I couldn't complete that request. ${getErrorMessage(error)}`,
          isError: true,
        },
      ]);
    } finally {
      resetRequestState();
    }
  }

  // Retry a failed assistant response.
  async function retryMessage(index: number) {
    if (requestInProgress.current || !activeChatId) return;

    const history = messages.slice(0, index);

    if (history.at(-1)?.role !== "user") return;

    requestInProgress.current = true;

    const chatId = activeChatId;

    setLoading(true);
    setStreaming(false);
    setHasReceivedFirstChunk(false);

    saveConversation(chatId, [
      ...history,
      { role: "assistant", content: "" },
    ]);

    try {
      const answer = await getAnswer(history, (fullText) => {
        if (!requestInProgress.current) return;

        setStreaming(true);
        setHasReceivedFirstChunk(true);

        saveConversation(chatId, [
          ...history,
          { role: "assistant", content: fullText },
        ]);
      });

      saveConversation(chatId, [
        ...history,
        { role: "assistant", content: answer },
      ]);
    } catch (error) {
      saveConversation(chatId, [
        ...history,
        {
          role: "assistant",
          content: `I couldn't complete that request. ${getErrorMessage(error)}`,
          isError: true,
        },
      ]);
    } finally {
      resetRequestState();
    }
  }

  // Copy a response.
  async function copyMessage(content: string, index: number) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);

      window.setTimeout(() => {
        setCopiedIndex((current) => current === index ? null : current);
      }, 1500);
    } catch {
      console.error("Clipboard access was blocked.");
    }
  }

  // Start a fresh conversation.
  function startNewChat() {
    if (requestInProgress.current) return;

    updateChatUrl(null);

    setActiveView("chat");
    setActiveChatId(null);
    setMessages([]);
    setInput("");
    setHistorySearch("");
    setRenamingChatId(null);
    inputRef.current?.focus();
  }

  // Open a saved conversation.
  function openConversation(chat: Conversation) {
    if (requestInProgress.current) return;

    updateChatUrl(chat.id);

    setActiveView("chat");
    setActiveChatId(chat.id);
    setMessages(chat.messages);
    setInput("");
    setRenamingChatId(null);
    inputRef.current?.focus();
  }

  // Delete a conversation from the account.
  async function deleteConversation(chatId: string) {
    if (requestInProgress.current) return;

    setConversations((previous) =>
      previous.filter((chat) => chat.id !== chatId)
    );

    if (activeChatId === chatId) {
      setActiveChatId(null);
      setMessages([]);
      updateChatUrl(null);
    }

    if (renamingChatId === chatId) {
      setRenamingChatId(null);
    }

    try {
      await workerRequest(
        `/conversations/${encodeURIComponent(chatId)}`,
        "DELETE"
      );

      syncedIds.current.delete(chatId);
    } catch (error) {
      setAuthError(`Could not delete chat: ${getErrorMessage(error)}`);
    }
  }

  // Rename a conversation.
  function beginRename(chat: Conversation) {
    if (requestInProgress.current) return;

    setRenamingChatId(chat.id);
    setRenameValue(chat.title);
  }

  function saveRename(chatId: string) {
    const title = renameValue
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);

    if (title) {
      setConversations((previous) =>
        previous.map((chat) =>
          chat.id === chatId
            ? { ...chat, title, updatedAt: new Date().toISOString() }
            : chat
        )
      );
    }

    setRenamingChatId(null);
    setRenameValue("");
  }

  function useSuggestion(prompt: string) {
    if (loading) return;

    setInput(prompt);
    inputRef.current?.focus();
  }

  function handleComposerKeyDown(
    event: KeyboardEvent<HTMLTextAreaElement>
  ) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void sendMessage();
    }
  }

  // Authentication form actions.
  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setAuthError("");
    setAuthMessage("");

    if (!email.trim() && authMode !== "reset") {
      setAuthError("Enter your email address.");
      return;
    }

    if (authMode === "forgot") {
      setAuthLoading(true);

      try {
        const { error } = await supabase.auth.resetPasswordForEmail(
          email.trim(),
          {
            redirectTo: `${window.location.origin}/`,
          }
        );

        if (error) throw error;

        setAuthMessage(
          "If an account exists for that email, a password recovery link will be sent."
        );
      } catch (error) {
        setAuthError(getErrorMessage(error));
      } finally {
        setAuthLoading(false);
      }

      return;
    }

    if (authMode === "reset") {
      if (password.length < 8) {
        setAuthError("Your new password must be at least 8 characters.");
        return;
      }

      if (password !== confirmPassword) {
        setAuthError("Your passwords do not match.");
        return;
      }

      setAuthLoading(true);

      try {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;

        setAuthMessage("Your password has been updated.");
        setPassword("");
        setConfirmPassword("");
        setAuthMode("login");
      } catch (error) {
        setAuthError(getErrorMessage(error));
      } finally {
        setAuthLoading(false);
      }

      return;
    }

    if (password.length < 8) {
      setAuthError("Your password must be at least 8 characters.");
      return;
    }

    if (authMode === "signup" && password !== confirmPassword) {
      setAuthError("Your passwords do not match.");
      return;
    }

    setAuthLoading(true);

    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
          },
        });

        if (error) throw error;

        if (data.session) {
          setAuthMessage("Your account has been created.");
        } else {
          setAuthMessage(
            "Account created! Check your email and click the verification link before signing in."
          );
          setAuthMode("login");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });

        if (error) throw error;

        setAuthMessage("");
      }
    } catch (error) {
      setAuthError(getErrorMessage(error));
    } finally {
      setAuthLoading(false);
    }
  }

  async function signOut() {
    if (requestInProgress.current) return;

    const { error } = await supabase.auth.signOut();

    if (error) {
      setAuthError(error.message);
      return;
    }

    setConversations([]);
    setMessages([]);
    setActiveChatId(null);
    setStorageReady(false);
    syncedIds.current.clear();
    setAuthMode("login");
    setAuthMessage("");
  }

  // Detect password recovery links.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const hash = window.location.hash;

    if (
      hash.includes("type=recovery") ||
      new URLSearchParams(window.location.search).get("type") === "recovery"
    ) {
      setAuthMode("reset");
      setAuthMessage("Choose a new password for your account.");
    }
  }, []);

  const canSend =
    input.trim().length > 0 &&
    input.length <= MAX_MESSAGE_LENGTH &&
    !loading &&
    storageReady &&
    Boolean(session);

  if (!authReady) {
    return (
      <main className={styles.authPage}>
        <div className={styles.authCard}>
          <div className={styles.authLogo}>K</div>
          <p className={styles.authEyebrow}>KRAZY AI</p>
          <h1 className={styles.authTitle}>Loading...</h1>
        </div>
      </main>
    );
  }

  // Account screen.
  if (!session) {
    const authTitle = {
      login: "WELCOME BACK.",
      signup: "JOIN KRAZY AI.",
      forgot: "RESET PASSWORD.",
      reset: "NEW PASSWORD.",
    }[authMode];

    const authDescription = {
      login: "Sign in to access your conversations.",
      signup: "Create an account and take your chats anywhere.",
      forgot: "We'll send you a password recovery link.",
      reset: "Choose a new password for your account.",
    }[authMode];

    return (
      <main className={styles.authPage}>
        <section className={styles.authCard}>
          <a
            className={styles.authBrand}
            href="/"
            aria-label="Krazy AI"
          >
            <span className={styles.authLogo}>K</span>
            <span>KRAZY <strong>AI</strong></span>
          </a>

          <p className={styles.authEyebrow}>THINK BIGGER. GO KRAZY.</p>
          <h1 className={styles.authTitle}>{authTitle}</h1>
          <p className={styles.authDescription}>{authDescription}</p>

          <form className={styles.authForm} onSubmit={handleAuthSubmit}>
            {authMode !== "reset" && (
              <label className={styles.authLabel}>
                Email address
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </label>
            )}

            {authMode !== "forgot" && (
              <label className={styles.authLabel}>
                {authMode === "reset" ? "New password" : "Password"}
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete={
                    authMode === "signup" || authMode === "reset"
                      ? "new-password"
                      : "current-password"
                  }
                  minLength={8}
                  required
                />
              </label>
            )}

            {(authMode === "reset" || authMode === "signup") && (
              <label className={styles.authLabel}>
                {authMode === "reset"
                  ? "Confirm new password"
                  : "Confirm password"}
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Enter your password again"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>
            )}

            {authError && (
              <p className={styles.authError} role="alert">
                {authError}
              </p>
            )}

            {authMessage && (
              <p className={styles.authSuccess} role="status">
                {authMessage}
              </p>
            )}

            <button
              className={styles.authSubmit}
              type="submit"
              disabled={authLoading}
            >
              {authLoading
                ? "PLEASE WAIT..."
                : authMode === "login"
                  ? "SIGN IN"
                  : authMode === "signup"
                    ? "CREATE ACCOUNT"
                    : authMode === "forgot"
                      ? "SEND RECOVERY LINK"
                      : "UPDATE PASSWORD"}
            </button>
          </form>

          {authMode === "login" && (
            <>
              <button
                className={styles.authTextButton}
                type="button"
                onClick={() => {
                  setAuthMode("forgot");
                  setAuthError("");
                  setAuthMessage("");
                }}
              >
                Forgot password?
              </button>

              <p className={styles.authSwitch}>
                Don't have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode("signup");
                    setAuthError("");
                    setAuthMessage("");
                  }}
                >
                  Create one
                </button>
              </p>
            </>
          )}

          {authMode === "signup" && (
            <p className={styles.authSwitch}>
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => {
                  setAuthMode("login");
                  setAuthError("");
                  setAuthMessage("");
                }}
              >
                Sign in
              </button>
            </p>
          )}

          {(authMode === "forgot" || authMode === "reset") && (
            <p className={styles.authSwitch}>
              <button
                type="button"
                onClick={() => {
                  setAuthMode("login");
                  setAuthError("");
                  setAuthMessage("");
                }}
              >
                Back to sign in
              </button>
            </p>
          )}

          <p className={styles.authFooter}>
            Your account keeps your conversations synced across devices.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.app}>
      <aside className={styles.sidebar} aria-label="Main sidebar">
        <a
          className={styles.sidebarBrand}
          href="/"
          onClick={(event) => {
            event.preventDefault();
            startNewChat();
          }}
          aria-label="Krazy AI home"
        >
          <span className={styles.sidebarLogo}>K</span>
          <span>
            Krazy <span className={styles.sidebarBrandAccent}>AI</span>
          </span>
        </a>

                {ownerMode && (
          <div
            style={{
              margin: "8px 0 12px",
              padding: "8px 12px",
              border: "1px solid #cc0000",
              borderRadius: "8px",
              color: "#ff4444",
              fontSize: "12px",
              fontWeight: 700,
              letterSpacing: "1px",
              textAlign: "center",
            }}
          >
            ★ OWNER MODE ACTIVE
          </div>
        )}

        <button
          className={styles.sidebarNewChat}
          type="button"
          onClick={startNewChat}
          disabled={loading || !storageReady}
        >
          <span aria-hidden="true">＋</span>
          New Chat
        </button>

        <button
          type="button"
          className={`${styles.sidebarPersonalization} ${
            activeView === "personalization" ? styles.sidebarPersonalizationActive : ""
          }`}
          onClick={() => {
            setActiveView("personalization");
            setPreferencesMessage("");
            setPreferencesError("");
          }}
        >
          <span aria-hidden="true">⚙</span>
          Personalization
        </button>

        <input
          className={styles.sidebarSearch}
          type="search"
          value={historySearch}
          onChange={(event) => setHistorySearch(event.target.value)}
          placeholder="Search chats..."
          aria-label="Search conversations"
        />

        <h2 className={styles.sidebarSectionTitle}>Your Chats</h2>

        <div className={styles.sidebarHistory}>
          {!storageReady ? (
            <p className={styles.emptyHistory}>Loading chats...</p>
          ) : filteredConversations.length === 0 ? (
            <p className={styles.emptyHistory}>
              {historySearch
                ? "No matching chats."
                : "Your conversations will appear here."}
            </p>
          ) : (
            filteredConversations.map((chat) => (
              <div
                className={`${styles.sidebarChat} ${
                  chat.id === activeChatId && activeView === "chat" ? styles.active : ""
                }`}
                key={chat.id}
              >
                {renamingChatId === chat.id ? (
                  <form
                    className={styles.renameForm}
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveRename(chat.id);
                    }}
                  >
                    <input
                      ref={renameRef}
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      maxLength={60}
                      aria-label="New conversation name"
                    />

                    <button type="submit" title="Save" aria-label="Save name">
                      ✓
                    </button>

                    <button
                      type="button"
                      title="Cancel"
                      aria-label="Cancel rename"
                      onClick={() => {
                        setRenamingChatId(null);
                        setRenameValue("");
                      }}
                    >
                      ×
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      className={styles.sidebarChatOpen}
                      type="button"
                      onClick={() => openConversation(chat)}
                      title={chat.title}
                    >
                      <strong>{chat.title}</strong>
                    </button>

                    <div className={styles.sidebarChatTools}>
                      <button
                        type="button"
                        onClick={() => beginRename(chat)}
                        disabled={loading}
                        title="Rename chat"
                        aria-label={`Rename ${chat.title}`}
                      >
                        ✎
                      </button>

                      <button
                        type="button"
                        onClick={() => void deleteConversation(chat.id)}
                        disabled={loading}
                        title="Delete chat"
                        aria-label={`Delete ${chat.title}`}
                      >
                        ×
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        <div className={styles.sidebarBottom}>
          <div className={styles.accountPanel}>
            <div className={styles.accountAvatar}>
              {(session.user.email?.[0] || "U").toUpperCase()}
            </div>

            <div className={styles.accountDetails}>
              <strong>Signed in</strong>
              <span>{session.user.email}</span>
            </div>

            <button
              className={styles.signOutButton}
              type="button"
              onClick={() => void signOut()}
              title="Sign out"
            >
              ↪
            </button>
          </div>

          <p className={styles.sidebarStorage}>
            Your chats are saved to your account.
          </p>
        </div>
      </aside>

      <div className={styles.mainContent}>
        {activeView === "personalization" ? (
          <section className={styles.personalizationPage}>
            <div className={styles.personalizationHeader}>
              <p className={styles.eyebrow}>MAKE IT YOURS</p>
              <h1>Personalization</h1>
              <p>
                Choose how KRAZY AI communicates with you. These settings are
                saved to your account and follow you across devices.
              </p>
            </div>

            <div className={styles.personalizationSection}>
              <h2>Choose a personality</h2>
              <p className={styles.personalizationHint}>
                This changes the way KRAZY AI communicates, not its intelligence
                or capabilities.
              </p>

              <div className={styles.personalityGrid}>
                {PERSONALITIES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`${styles.personalityCard} ${
                      personality === option.id
                        ? styles.personalityCardActive
                        : ""
                    }`}
                    onClick={() => {
                      setPersonality(option.id);
                      setPreferencesMessage("");
                      setPreferencesError("");
                    }}
                    aria-pressed={personality === option.id}
                  >
                    <span className={styles.personalityCardTop}>
                      <strong>{option.name}</strong>
                      <span className={styles.personalityRadio}>
                        {personality === option.id ? "✓" : ""}
                      </span>
                    </span>

                    <span className={styles.personalityDescription}>
                      {option.description}
                    </span>

                    <span className={styles.personalityPreview}>
                      {option.preview}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.personalizationSection}>
              <div className={styles.customInstructionsHeader}>
                <h2>Custom instructions</h2>
                <span>
                  {customInstructions.length}/{MAX_CUSTOM_INSTRUCTIONS}
                </span>
              </div>

              <p className={styles.personalizationHint}>
                Add extra guidance about how you want KRAZY AI to respond.
                This is optional.
              </p>

              <textarea
                className={styles.customInstructions}
                value={customInstructions}
                onChange={(event) => {
                  setCustomInstructions(
                    event.target.value.slice(0, MAX_CUSTOM_INSTRUCTIONS)
                  );
                  setPreferencesMessage("");
                  setPreferencesError("");
                }}
                maxLength={MAX_CUSTOM_INSTRUCTIONS}
                rows={5}
                placeholder="Example: Explain complicated topics step by step. Use examples when helpful. Keep answers organized..."
                disabled={preferencesLoading}
              />
            </div>

            {preferencesLoading && (
              <p className={styles.preferencesStatus}>
                Loading your saved preferences...
              </p>
            )}

            {preferencesError && (
              <p className={styles.preferencesError} role="alert">
                {preferencesError}
              </p>
            )}

            {preferencesMessage && (
              <p className={styles.preferencesStatus} role="status">
                {preferencesMessage}
              </p>
            )}

            <button
              type="button"
              className={styles.savePreferencesButton}
              onClick={() => void savePreferences()}
              disabled={
                preferencesLoading ||
                preferencesSaving ||
                !session
              }
            >
              {preferencesSaving ? "SAVING..." : "SAVE PREFERENCES"}
            </button>
          </section>
        ) : (
          <>
            <section className={styles.chat} aria-label="Chat conversation">
              {messages.length === 0 ? (
                <div className={styles.welcome}>
                  <div className={styles.welcomeLogo}>K</div>

                  <p className={styles.eyebrow}>WELCOME TO KRAZY AI</p>

                  <h1 className={styles.welcomeTitle}>
                    THINK BIGGER.
                    <br />
                    <span>GO KRAZY.</span>
                  </h1>

                  <p className={styles.subtitle}>
                    Your ideas have no limits. Let's make something happen.
                  </p>

                  <button
                    type="button"
                    className={styles.welcomePrompt}
                    onClick={() => inputRef.current?.focus()}
                  >
                    <span>Ask Krazy AI anything...</span>
                    <span className={styles.promptArrow}>↓</span>
                  </button>

                  <p className={styles.suggestionHeading}>GET STARTED WITH</p>

                  <div className={styles.suggestions}>
                    {[
                      {
                        title: "Build something",
                        prompt: "Help me plan and build something awesome.",
                        symbol: "＋",
                      },
                      {
                        title: "Brainstorm ideas",
                        prompt: "Help me brainstorm creative and original ideas.",
                        symbol: "✳",
                      },
                      {
                        title: "Learn something",
                        prompt: "Teach me something interesting and explain it clearly.",
                        symbol: "⌘",
                      },
                      {
                        title: "Create something",
                        prompt: "Help me create something from scratch.",
                        symbol: "✦",
                      },
                    ].map((item) => (
                      <button
                        key={item.title}
                        type="button"
                        className={styles.suggestion}
                        onClick={() => useSuggestion(item.prompt)}
                      >
                        <span className={styles.suggestionIcon}>{item.symbol}</span>
                        <span className={styles.suggestionText}>
                          <strong>{item.title}</strong>
                        </span>
                        <span className={styles.suggestionArrow} aria-hidden="true">
                          ↗
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className={styles.messages}>
                  {messages.map((message, index) => {
                    if (
                      message.role === "assistant" &&
                      !message.content &&
                      loading
                    ) {
                      return null;
                    }

                    return (
                      <article
                        key={`${index}-${message.role}`}
                        className={`${styles.message} ${
                          message.role === "user"
                            ? styles.userMessage
                            : styles.assistantMessage
                        }`}
                      >
                        {message.role === "assistant" && (
                          <div className={styles.avatar}>
                            <img src="/icon.png" alt="KRAZY AI" />
                          </div>
                        )}

                        <div className={styles.messageBody}>
                          <div className={styles.messageLabel}>
                            {message.role === "user" ? "You" : "Krazy AI"}
                          </div>

                          <div
                            className={`${styles.messageText} ${
                              message.isError ? styles.errorText : ""
                            }`}
                          >
                            {message.content ? (
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {message.content}
                              </ReactMarkdown>
                            ) : loading && index === messages.length - 1 ? (
                              <span className={styles.thinkingText}>
                                Preparing your response...
                              </span>
                            ) : null}

                            {streaming &&
                              message.role === "assistant" &&
                              index === messages.length - 1 && (
                                <span className={styles.streamingCursor}>▍</span>
                              )}
                          </div>

                          {message.role === "assistant" && message.content && (
                            <div className={styles.messageActions}>
                              {!message.isError && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void copyMessage(message.content, index)
                                  }
                                  title="Copy response"
                                >
                                  {copiedIndex === index ? "✓ Copied" : "Copy"}
                                </button>
                              )}

                              {message.isError && (
                                <button
                                  type="button"
                                  onClick={() => void retryMessage(index)}
                                  disabled={loading}
                                >
                                  ↻ Try again
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })}

                  {loading && !hasReceivedFirstChunk && (
                    <div className={styles.thinking}>
                      <div className={styles.avatar}>
                        <img src="/icon.png" alt="KRAZY AI" />
                      </div>

                      <div>
                        <div className={styles.messageLabel}>Krazy AI</div>
                        <div className={styles.thinkingText}>
                          <span />
                          <span />
                          <span />
                          <span className={styles.thinkingLabel}>Thinking</span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div ref={bottomRef} />
                </div>
              )}
            </section>

            <footer className={styles.composerArea}>
              {authError && (
                <p className={styles.accountNotice} role="alert">
                  {authError}
                  <button
                    type="button"
                    onClick={() => setAuthError("")}
                    aria-label="Dismiss message"
                  >
                    ×
                  </button>
                </p>
              )}

              <div className={styles.modePicker}>
                <label htmlFor="krazy-ai-mode">AI MODE</label>
                <select
                  id="krazy-ai-mode"
                  value={aiMode}
                  onChange={(event) => setAiMode(event.target.value as AiMode)}
                  disabled={loading}
                  aria-label="Choose KRAZY AI response mode"
                >
                  <option value="flash">KRAZY FLASH · Fast and concise</option>
                  <option value="core">KRAZY CORE · Balanced (Default)</option>
                  <option value="think">KRAZY THINK · Complex reasoning</option>
                  <option value="deep">KRAZY DEEP · Deep analysis</option>
                  <option value="omega" disabled>KRAZY OMEGA · Premium — Coming Soon</option>
                </select>
                <span className={styles.modeHint}>
                  {aiMode === "flash" && "Prioritizes quick, direct answers."}
                  {aiMode === "core" && "Balanced detail, speed, and clarity."}
                  {aiMode === "think" && "Takes a more structured approach to difficult problems."}
                  {aiMode === "deep" && "Explores a topic in greater depth; live web research is not included."}
                  {aiMode === "omega" && "Premium mode is not available yet."}
                </span>
              </div>

              <form
                className={styles.composer}
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendMessage();
                }}
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="Message KRAZY AI..."
                  aria-label="Message Krazy AI"
                  rows={1}
                  maxLength={MAX_MESSAGE_LENGTH}
                  disabled={loading || !storageReady}
                />

                <button
                  className={styles.sendButton}
                  type="submit"
                  disabled={!canSend}
                  aria-label="Send message"
                  title="Send message"
                >
                  {loading ? "…" : "↑"}
                </button>
              </form>

              <div className={styles.disclaimer}>
                <span>
                  {input.length}/{MAX_MESSAGE_LENGTH}
                </span>
                <span>Enter to send · Shift + Enter for a new line</span>
                <span>Krazy AI can make mistakes. Check important information.</span>
              </div>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
