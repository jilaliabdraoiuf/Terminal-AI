'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { signInWithGoogle, logOut, db } from '@/lib/firebase';
import { collection, addDoc, query, orderBy, onSnapshot, serverTimestamp, doc, setDoc, getDocs, where, updateDoc } from 'firebase/firestore';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import { motion } from 'motion/react';
import { Download, LogOut, LogIn, Terminal as TerminalIcon, Key, Copy, Check, Eye, EyeOff } from 'lucide-react';
import JSZip from 'jszip';

const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });

interface Message {
  id: string;
  role: 'user' | 'ai' | 'system';
  text: string;
  imageUrl?: string;
  videoUrl?: string;
  createdAt: any;
}

interface ProjectFile {
  name: string;
  content: string;
}

const VideoPlayer = ({ uri }: { uri: string }) => {
  const [blobUrl, setBlobUrl] = useState<string>('');
  useEffect(() => {
    const fetchVideo = async () => {
      try {
        const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
        const res = await fetch(uri, { headers: { 'x-goog-api-key': apiKey || '' } });
        const blob = await res.blob();
        setBlobUrl(URL.createObjectURL(blob));
      } catch (e) {
        console.error("Failed to load video", e);
      }
    };
    fetchVideo();
  }, [uri]);
  if (!blobUrl) return <div className="animate-pulse text-green-700 mt-2">Loading video stream...</div>;
  return <video src={blobUrl} controls className="max-w-full rounded border border-green-800 mt-2" />;
};

export default function Terminal() {
  const { user, loading } = useAuth();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [generatedFiles, setGeneratedFiles] = useState<ProjectFile[]>([]);
  const [showFiles, setShowFiles] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [clearedAt, setClearedAt] = useState<number>(0);
  const [hasApiKey, setHasApiKey] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const checkKey = async () => {
      if (typeof window !== 'undefined' && (window as any).aistudio) {
        const hasKey = await (window as any).aistudio.hasSelectedApiKey();
        setHasApiKey(hasKey);
      }
    };
    checkKey();
  }, []);

  const handleSetApiKey = async () => {
    if (typeof window !== 'undefined' && (window as any).aistudio) {
      await (window as any).aistudio.openSelectKey();
      setHasApiKey(true);
    }
  };

  useEffect(() => {
    if (!user) {
      setMessages([{
        id: 'system-1',
        role: 'system',
        text: 'Welcome to AI Terminal. Please log in to continue.',
        createdAt: new Date()
      }]);
      return;
    }

    const q = query(
      collection(db, 'messages'),
      where('userId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs
        .map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as Message[];
        
      msgs.sort((a, b) => {
        const tA = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const tB = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return tA - tB; // ascending
      });
      
      setMessages(msgs);
    });

    return () => unsubscribe();
  }, [user]);

  const visibleMessages = messages.filter(m => {
    if (!m.createdAt) return true; // Optimistic updates might not have server timestamp yet
    const timestamp = m.createdAt.toMillis ? m.createdAt.toMillis() : new Date(m.createdAt).getTime();
    return timestamp > clearedAt;
  });

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [visibleMessages, isProcessing, streamingText, input]);

  // Auto-scroll textarea to bottom when typing long commands
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
    }
  }, [input]);

  // Load saved input from local storage on mount
  useEffect(() => {
    const savedInput = localStorage.getItem('terminal_draft_input');
    if (savedInput) {
      setInput(savedInput);
    }
  }, []);

  // Auto-save input to local storage when it changes
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (input !== undefined) {
        localStorage.setItem('terminal_draft_input', input);
      }
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [input]);

  const handleCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !user || isProcessing) return;

    const command = input.trim();
    setInput('');
    localStorage.removeItem('terminal_draft_input');

    if (command.toLowerCase() === 'clear') {
      setClearedAt(Date.now());
      setGeneratedFiles([]);
      return;
    }

    if (command.toLowerCase() === 'help') {
      const helpMsg = `Available commands:
  clear    - Clear the terminal screen
  help     - Show this help message
  ls       - List previously generated projects
  build-ai - Create an autonomous AI from scratch based on your idea
  
Any other input will be sent to the AI assistant. You can ask it to build apps, write scripts, or answer questions.`;
      
      await addDoc(collection(db, 'messages'), {
        userId: user.uid,
        role: 'system',
        text: helpMsg,
        createdAt: serverTimestamp()
      });
      return;
    }

    if (command.toLowerCase() === 'ls') {
      try {
        const projectsRef = collection(db, 'projects');
        const q = query(projectsRef, where('userId', '==', user.uid));
        
        const snapshot = await getDocs(q);
        const userProjects = snapshot.docs.sort((a, b) => {
          const tA = a.data().createdAt?.toMillis ? a.data().createdAt.toMillis() : 0;
          const tB = b.data().createdAt?.toMillis ? b.data().createdAt.toMillis() : 0;
          return tB - tA; // descending
        });
        
        let lsMsg = 'Generated Projects:\n';
        if (userProjects.length === 0) {
          lsMsg += 'No projects found.';
        } else {
          userProjects.forEach((doc, idx) => {
            const data = doc.data();
            const date = data.createdAt?.toDate ? data.createdAt.toDate().toLocaleString() : 'Unknown date';
            lsMsg += `[${idx + 1}] ${data.title} (${date})\n`;
          });
        }
        
        await addDoc(collection(db, 'messages'), {
          userId: user.uid,
          role: 'system',
          text: lsMsg,
          createdAt: serverTimestamp()
        });
      } catch (e) {
        console.error(e);
      }
      return;
    }

    setIsProcessing(true);

    try {
      // Add user message to Firestore
      await addDoc(collection(db, 'messages'), {
        userId: user.uid,
        role: 'user',
        text: command,
        createdAt: serverTimestamp()
      });

      // Prepare chat history for AI
      const chatHistory = visibleMessages.map(m => ({
        role: m.role === 'ai' ? 'model' : m.role === 'user' ? 'user' : 'user',
        parts: [{ text: m.text }]
      })).filter(m => m.role !== 'system');

      const tools = [
        { googleSearch: {} },
        {
          functionDeclarations: [
            {
              name: "save_project",
              description: "Save generated project files when the user asks to build an app or project.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  files: {
                    type: Type.ARRAY,
                    description: "List of files to generate",
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING, description: "Filename with extension" },
                        content: { type: Type.STRING, description: "File content" }
                      },
                      required: ["name", "content"]
                    }
                  },
                  summary: { type: Type.STRING, description: "A short summary of what was built" }
                },
                required: ["files", "summary"]
              }
            },
            {
              name: "generate_image",
              description: "Generate an image based on a prompt.",
              parameters: {
                type: Type.OBJECT,
                properties: { prompt: { type: Type.STRING } },
                required: ["prompt"]
              }
            },
            {
              name: "generate_video",
              description: "Generate a video based on a prompt.",
              parameters: {
                type: Type.OBJECT,
                properties: { prompt: { type: Type.STRING } },
                required: ["prompt"]
              }
            },
            {
              name: "store_info",
              description: "Store information or data for the user.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  key: { type: Type.STRING, description: "A unique identifier for the data" },
                  data: { type: Type.STRING, description: "The data to store" }
                },
                required: ["key", "data"]
              }
            },
            {
              name: "fetch_info",
              description: "Fetch previously stored information by key.",
              parameters: {
                type: Type.OBJECT,
                properties: { key: { type: Type.STRING } },
                required: ["key"]
              }
            },
            {
              name: "deploy_cloud_server",
              description: "Deploy and install a server automatically to the cloud. Use this when the user asks to run, host, or install a server.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  framework: { type: Type.STRING, description: "The framework or server type (e.g., Express, Django, Nginx, Node.js)" },
                  status: { type: Type.STRING, description: "Status message to show the user" }
                },
                required: ["framework", "status"]
              }
            }
          ]
        }
      ];

      let messagesToAi = [
        ...chatHistory,
        { role: 'user', parts: [{ text: command }] }
      ];

      setIsStreaming(true);
      let aiResponseText = '';
      let imageUrl = '';
      let functionResponses: any[] = [];
      let functionCalls: any[] = [];
      let aggregatedParts: any[] = [];

      const responseStream = await ai.models.generateContentStream({
        model: 'gemini-3.1-pro-preview',
        contents: messagesToAi,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          systemInstruction: "You are an autonomous Cloud Terminal AI, Expert AI Architect, Secure Web Crawler, and the core of 'التعلم البرمجي التلقائي بالانظمه' (Automatic Programmatic Learning by Systems). Respond concisely like a command-line interface. You support ALL operating systems (Windows, Linux, Android, iOS, macOS, and Xiaomi's HyperOS/MIUI specifically for building AI systems). You can build apps, generate images/videos, store/fetch data, and deploy cloud servers. Use the googleSearch tool to browse the web, verify information, find safe/free applications, and fetch secure open-source code snippets. If the user asks for apps for ANY OS, find the most powerful, latest, and 100% free/safe versions, verifying they are not fake or malicious. If the user asks to convert an app or build a custom app for Windows, Linux, Android, iOS, or Xiaomi systems, fetch secure code and generate the complete cross-platform application (e.g., using Electron, React Native, Flutter, or native code) using the 'save_project' tool. Act as an interactive chat assistant that provides direct, automatic commands and helps download/build apps seamlessly across all systems. CRITICAL: If the user asks to 'build an AI from scratch', analyze their idea, break it down, and generate the complete code.",
          tools
        }
      });

      for await (const chunk of responseStream) {
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.functionCall) {
            functionCalls.push(part.functionCall);
            aggregatedParts.push(part);
          } else if (part.text !== undefined) {
            aiResponseText += part.text;
            setStreamingText(aiResponseText);
            
            const lastPart = aggregatedParts[aggregatedParts.length - 1];
            const getKeys = (obj: any) => Object.keys(obj).filter(k => k !== 'text').sort().join(',');
            
            if (lastPart && lastPart.text !== undefined && getKeys(lastPart) === getKeys(part)) {
              lastPart.text += part.text;
            } else {
              aggregatedParts.push({ ...part });
            }
          } else {
            aggregatedParts.push(part);
          }
        }
      }

      if (functionCalls.length > 0) {
        for (const call of functionCalls) {
          if (call.name === 'save_project') {
            const args = call.args as any;
            const filesToSave = args.files || [];
            aiResponseText += `\n[System]: Project built successfully. ${args.summary}\nFiles generated: ${filesToSave.map((f: any) => f.name).join(', ')}`;
            setStreamingText(aiResponseText);
            setGeneratedFiles(filesToSave);
            
            const projectId = crypto.randomUUID();
            await setDoc(doc(db, 'projects', projectId), {
              id: projectId,
              userId: user.uid,
              title: args.summary || 'Generated Project',
              content: JSON.stringify(filesToSave),
              status: 'completed',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
            functionResponses.push({ functionResponse: { name: call.name, response: { success: true } } });
          }
          else if (call.name === 'generate_image') {
            const args = call.args as any;
            if (typeof window !== 'undefined' && (window as any).aistudio && !(await (window as any).aistudio.hasSelectedApiKey())) {
              await (window as any).aistudio.openSelectKey();
            }
            try {
              const mediaAi = new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY });
              const imgRes = await mediaAi.models.generateContent({
                model: 'gemini-3.1-flash-image-preview',
                contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
                config: { imageConfig: { imageSize: "512px" } }
              });
              for (const part of imgRes.candidates?.[0]?.content?.parts || []) {
                if (part.inlineData) {
                  imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                  break;
                }
              }
              functionResponses.push({ functionResponse: { name: call.name, response: { success: true } } });
            } catch (e: any) {
              console.error("Image generation error", e);
              if (e.message?.includes("Requested entity was not found") || e.message?.includes("API key not valid")) {
                if (typeof window !== 'undefined' && (window as any).aistudio) {
                  await (window as any).aistudio.openSelectKey();
                }
              }
              functionResponses.push({ functionResponse: { name: call.name, response: { success: false, error: e.message } } });
            }
          }
          else if (call.name === 'generate_video') {
            const args = call.args as any;
            if (typeof window !== 'undefined' && (window as any).aistudio && !(await (window as any).aistudio.hasSelectedApiKey())) {
              await (window as any).aistudio.openSelectKey();
            }
            
            const startVideo = async () => {
              const msgRef = await addDoc(collection(db, 'messages'), {
                userId: user.uid,
                role: 'system',
                text: `Generating video for: "${args.prompt}"... This may take a few minutes.`,
                createdAt: serverTimestamp()
              });
              try {
                const mediaAi = new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY });
                let operation = await mediaAi.models.generateVideos({
                  model: 'veo-3.1-fast-generate-preview',
                  prompt: args.prompt,
                  config: { numberOfVideos: 1, resolution: '720p', aspectRatio: '16:9' }
                });

                while (!operation.done) {
                  await new Promise(resolve => setTimeout(resolve, 10000));
                  operation = await mediaAi.operations.getVideosOperation({operation});
                }
                
                const uri = operation.response?.generatedVideos?.[0]?.video?.uri;
                if (uri) {
                  await updateDoc(msgRef, { text: `Video generated for: "${args.prompt}"`, videoUrl: uri });
                } else {
                  await updateDoc(msgRef, { text: `Failed to generate video for: "${args.prompt}"` });
                }
              } catch (e: any) {
                console.error("Video generation error", e);
                if (e.message?.includes("Requested entity was not found") || e.message?.includes("API key not valid")) {
                  if (typeof window !== 'undefined' && (window as any).aistudio) {
                    await (window as any).aistudio.openSelectKey();
                  }
                }
                await updateDoc(msgRef, { text: `Failed to generate video for: "${args.prompt}". Error: ${e.message}` });
              }
            };
            startVideo();
            functionResponses.push({ functionResponse: { name: call.name, response: { success: true, message: "Video generation started in the background." } } });
          }
          else if (call.name === 'store_info') {
            const args = call.args as any;
            await addDoc(collection(db, 'user_data'), {
              userId: user.uid,
              key: args.key,
              data: args.data,
              createdAt: serverTimestamp()
            });
            functionResponses.push({ functionResponse: { name: call.name, response: { success: true } } });
          }
          else if (call.name === 'fetch_info') {
            const args = call.args as any;
            const q = query(collection(db, 'user_data'), where('userId', '==', user.uid), where('key', '==', args.key));
            const snap = await getDocs(q);
            const data = snap.empty ? "Not found" : snap.docs[0].data().data;
            functionResponses.push({ functionResponse: { name: call.name, response: { data } } });
          }
          else if (call.name === 'deploy_cloud_server') {
            const args = call.args as any;
            const mockUrl = `https://${args.framework.toLowerCase().replace(/[^a-z0-9]/g, '')}-${crypto.randomUUID().split('-')[0]}.cloud.ai-term.app`;
            aiResponseText += `\n[Cloud Orchestrator]: ${args.status}\n[Cloud Orchestrator]: Provisioning ${args.framework} server...\n[Cloud Orchestrator]: Installing dependencies...\n[Cloud Orchestrator]: Server successfully deployed and running at: ${mockUrl}`;
            setStreamingText(aiResponseText);
            functionResponses.push({ functionResponse: { name: call.name, response: { success: true, url: mockUrl } } });
          }
        }

        if (functionResponses.length > 0) {
          messagesToAi.push({
            role: 'model',
            parts: aggregatedParts.length > 0 ? aggregatedParts : functionCalls.map(call => ({ functionCall: call }))
          });
          messagesToAi.push({ role: 'user', parts: functionResponses });
          
          const secondStream = await ai.models.generateContentStream({
            model: 'gemini-3.1-pro-preview',
            contents: messagesToAi,
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              systemInstruction: "You are an autonomous Cloud Terminal AI. Respond concisely like a command-line interface. You can build apps, generate images/videos, store/fetch data, and deploy cloud servers. If the user asks to learn commands, act as an interactive tutorial step-by-step. If the user asks to create, install, or run a server/app, automatically generate the code and use the 'deploy_cloud_server' tool to simulate instant cloud deployment. Adapt automatically to any program or stack the user requests without needing manual configuration.",
              tools
            }
          });
          
          for await (const chunk of secondStream) {
            if (chunk.text) {
              aiResponseText += chunk.text;
              setStreamingText(aiResponseText);
            }
          }
        }
      }

      if (!aiResponseText && !imageUrl) {
        aiResponseText = "Command executed.";
      }

      // Add AI response to Firestore
      const msgData: any = {
        userId: user.uid,
        role: 'ai',
        text: aiResponseText,
        createdAt: serverTimestamp()
      };
      if (imageUrl) {
        msgData.imageUrl = imageUrl;
      }
      await addDoc(collection(db, 'messages'), msgData);

    } catch (error) {
      console.error("Error processing command:", error);
      await addDoc(collection(db, 'messages'), {
        userId: user.uid,
        role: 'system',
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        createdAt: serverTimestamp()
      });
    } finally {
      setIsProcessing(false);
      setIsStreaming(false);
      setStreamingText('');
    }
  };

  const downloadFiles = async () => {
    if (generatedFiles.length === 0) return;
    
    if (generatedFiles.length === 1) {
      const file = generatedFiles[0];
      const blob = new Blob([file.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const zip = new JSZip();
      generatedFiles.forEach(file => {
        zip.file(file.name, file.content);
      });
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'project_files.zip';
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const copyFilesToClipboard = async () => {
    if (generatedFiles.length === 0) return;
    let textToCopy = '';
    generatedFiles.forEach(file => {
      textToCopy += `--- ${file.name} ---\n${file.content}\n\n`;
    });
    try {
      await navigator.clipboard.writeText(textToCopy);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-black text-green-500 flex items-center justify-center font-mono">Initializing terminal...</div>;
  }

  return (
    <div className="min-h-screen bg-black text-green-500 font-mono flex flex-col p-4 md:p-8">
      <header className="flex justify-between items-center mb-6 border-b border-green-800 pb-4">
        <div className="flex items-center gap-2">
          <TerminalIcon className="w-6 h-6" />
          <h1 className="text-xl font-bold tracking-wider">AI_TERMINAL v1.0</h1>
        </div>
        <div>
          {user ? (
            <div className="flex items-center gap-4">
              <span className="text-sm opacity-70 hidden md:inline">{user.email}</span>
              {!hasApiKey && (
                <button 
                  onClick={handleSetApiKey}
                  className="flex items-center gap-2 hover:text-yellow-400 transition-colors text-yellow-500"
                  title="Required for Image/Video generation"
                >
                  <Key className="w-4 h-4" />
                  <span className="hidden sm:inline">SET API KEY</span>
                </button>
              )}
              <button 
                onClick={logOut}
                className="flex items-center gap-2 hover:text-green-400 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">EXIT</span>
              </button>
            </div>
          ) : (
            <button 
              onClick={signInWithGoogle}
              className="flex items-center gap-2 border border-green-500 px-4 py-2 hover:bg-green-900 transition-colors"
            >
              <LogIn className="w-4 h-4" />
              <span>LOGIN</span>
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-hidden flex flex-col gap-4">
        {/* Top Panel: Output Console */}
        <div className="flex-1 border border-green-800 rounded p-4 flex flex-col overflow-hidden bg-black/40 relative">
          <div className="flex justify-between items-center border-b border-green-800 pb-2 mb-4 shrink-0">
            <h2 className="text-sm font-bold text-green-400">CONSOLE OUTPUT</h2>
            <span className="text-xs text-green-700 font-bold">{user ? 'user@ai-term:~$' : 'guest@ai-term:~$'}</span>
          </div>
          
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto space-y-4 pb-4 custom-scrollbar pr-2">
            {visibleMessages.map((msg, idx) => (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                key={msg.id || idx} 
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div className={`max-w-[90%] break-words whitespace-pre-wrap ${
                  msg.role === 'user' ? 'text-blue-400 bg-blue-950/20 p-3 rounded border border-blue-900/50' : 
                  msg.role === 'system' ? 'text-yellow-500 bg-yellow-950/10 p-3 rounded border border-yellow-900/30' : 'text-green-500'
                }`} dir="auto">
                  {msg.role === 'user' ? '> ' : msg.role === 'system' ? '[SYS] ' : ''}
                  {msg.text}
                  {msg.imageUrl && (
                    <img src={msg.imageUrl} alt="Generated" className="mt-3 max-w-full rounded border border-green-800 shadow-lg" />
                  )}
                  {msg.videoUrl && (
                    <VideoPlayer uri={msg.videoUrl} />
                  )}
                </div>
              </motion.div>
            ))}
            {isStreaming && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-start"
              >
                <div className="max-w-[90%] break-words whitespace-pre-wrap text-green-500" dir="auto">
                  {streamingText}
                  <span className="animate-pulse font-bold text-green-400">_</span>
                </div>
              </motion.div>
            )}
            {isProcessing && !isStreaming && (
              <div className="text-green-500 animate-pulse text-sm">
                Processing request...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Generated Files (if any) */}
        {generatedFiles.length > 0 && (
          <div className="border border-green-500 bg-green-900/20 p-4 rounded flex flex-col gap-4 shrink-0">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div>
                <h3 className="text-sm font-bold mb-1 text-green-400">GENERATED FILES</h3>
                <p className="text-xs text-green-500">{generatedFiles.length} file(s) ready for download.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button 
                  onClick={() => setShowFiles(!showFiles)}
                  className="flex items-center justify-center gap-2 border border-green-600 text-green-500 px-4 py-2 text-sm font-bold hover:bg-green-900 transition-colors"
                >
                  {showFiles ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  {showFiles ? 'HIDE CODE' : 'VIEW CODE'}
                </button>
                <button 
                  onClick={downloadFiles}
                  className="flex items-center justify-center gap-2 bg-green-600 text-black px-4 py-2 text-sm font-bold hover:bg-green-500 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  DOWNLOAD
                </button>
                <button 
                  onClick={copyFilesToClipboard}
                  className="flex items-center justify-center gap-2 border border-green-600 text-green-500 px-4 py-2 text-sm font-bold hover:bg-green-900 transition-colors"
                >
                  {isCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {isCopied ? 'COPIED!' : 'COPY FILES'}
                </button>
              </div>
            </div>
            
            {showFiles && (
              <div className="mt-2 border-t border-green-800 pt-4 flex flex-col gap-4 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
                {generatedFiles.map((file, idx) => (
                  <div key={idx} className="bg-black/60 rounded border border-green-800 overflow-hidden">
                    <div className="bg-green-950/50 px-3 py-1 border-b border-green-800 text-xs font-mono text-green-400">
                      {file.name}
                    </div>
                    <pre className="p-3 text-xs font-mono text-green-500 overflow-x-auto custom-scrollbar">
                      <code>{file.content}</code>
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Bottom Panel: Input & Controls */}
        <div className="border border-green-800 rounded p-4 flex flex-col bg-green-950/10 shrink-0">
          <form onSubmit={handleCommand} className="flex flex-col sm:flex-row gap-4">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (input.trim() && user && !isProcessing) {
                    handleCommand(e as any);
                  }
                }
              }}
              disabled={!user || isProcessing}
              className="flex-1 bg-black/50 border border-green-800 rounded p-3 outline-none text-green-500 placeholder-green-800 font-mono resize-none focus:border-green-500 transition-colors custom-scrollbar min-h-[60px] max-h-[200px]"
              placeholder={user ? "Type your command here... (Press Enter to submit, Shift+Enter for new line)" : "Please login to use the terminal"}
              autoFocus
              rows={2}
            />
            <button 
              type="submit"
              disabled={!user || isProcessing || !input.trim()}
              className="sm:w-32 bg-green-900/30 border border-green-500 text-green-500 px-4 py-3 font-bold hover:bg-green-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2"
            >
              {isProcessing ? (
                <span className="animate-pulse">...</span>
              ) : (
                <>EXECUTE <TerminalIcon className="w-4 h-4" /></>
              )}
            </button>
          </form>
        </div>
      </main>
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #000;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #0f5132;
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #198754;
        }
      `}} />
    </div>
  );
}
