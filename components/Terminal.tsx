'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { signInWithGoogle, logOut, db } from '@/lib/firebase';
import { collection, addDoc, query, orderBy, onSnapshot, serverTimestamp, doc, setDoc, getDocs, where, updateDoc } from 'firebase/firestore';
import { GoogleGenAI, Type } from '@google/genai';
import { motion } from 'motion/react';
import { Download, LogOut, LogIn, Terminal as TerminalIcon, Key } from 'lucide-react';

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
  const [clearedAt, setClearedAt] = useState<number>(0);
  const [hasApiKey, setHasApiKey] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages, isProcessing, streamingText]);

  const handleCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !user || isProcessing) return;

    const command = input.trim();
    setInput('');

    if (command.toLowerCase() === 'clear') {
      setClearedAt(Date.now());
      setGeneratedFiles([]);
      return;
    }

    if (command.toLowerCase() === 'help') {
      const helpMsg = `Available commands:
  clear  - Clear the terminal screen
  help   - Show this help message
  ls     - List previously generated projects
  
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

      const responseStream = await ai.models.generateContentStream({
        model: 'gemini-3.1-pro-preview',
        contents: messagesToAi,
        config: {
          systemInstruction: "You are an AI terminal assistant. Respond concisely like a command-line interface. You can build apps, generate images/videos, and store/fetch data.",
          tools
        }
      });

      for await (const chunk of responseStream) {
        if (chunk.text) {
          aiResponseText += chunk.text;
          setStreamingText(aiResponseText);
        }
        if (chunk.functionCalls) {
          functionCalls.push(...chunk.functionCalls);
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
            const mediaAi = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
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
          }
          else if (call.name === 'generate_video') {
            const args = call.args as any;
            if (typeof window !== 'undefined' && (window as any).aistudio && !(await (window as any).aistudio.hasSelectedApiKey())) {
              await (window as any).aistudio.openSelectKey();
            }
            
            const startVideo = async () => {
              try {
                const mediaAi = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
                let operation = await mediaAi.models.generateVideos({
                  model: 'veo-3.1-fast-generate-preview',
                  prompt: args.prompt,
                  config: { numberOfVideos: 1, resolution: '720p', aspectRatio: '16:9' }
                });
                
                const msgRef = await addDoc(collection(db, 'messages'), {
                  userId: user.uid,
                  role: 'system',
                  text: `Generating video for: "${args.prompt}"... This may take a few minutes.`,
                  createdAt: serverTimestamp()
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
              } catch (e) {
                console.error("Video generation error", e);
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
        }

        if (functionResponses.length > 0) {
          messagesToAi.push({
            role: 'model',
            parts: functionCalls.map(call => ({ functionCall: call }))
          });
          messagesToAi.push({ role: 'user', parts: functionResponses });
          
          const secondStream = await ai.models.generateContentStream({
            model: 'gemini-3.1-pro-preview',
            contents: messagesToAi,
            config: {
              systemInstruction: "You are an AI terminal assistant. Respond concisely like a command-line interface. You can build apps, generate images/videos, and store/fetch data.",
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

  const downloadFiles = () => {
    if (generatedFiles.length === 0) return;
    
    // Create a simple text representation or trigger multiple downloads
    // For simplicity, let's create a single JSON file containing all files
    // or if it's a single file, download it directly.
    
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
      const content = JSON.stringify(generatedFiles, null, 2);
      const blob = new Blob([content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'project_files.json';
      a.click();
      URL.revokeObjectURL(url);
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

      <main className="flex-1 overflow-hidden flex flex-col relative">
        <div className="flex-1 overflow-y-auto space-y-4 pb-20 custom-scrollbar">
          {visibleMessages.map((msg, idx) => (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              key={msg.id || idx} 
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div className={`max-w-[80%] break-words whitespace-pre-wrap ${
                msg.role === 'user' ? 'text-blue-400' : 
                msg.role === 'system' ? 'text-yellow-500' : 'text-green-500'
              }`} dir="auto">
                {msg.role === 'user' ? '> ' : msg.role === 'system' ? '[SYS] ' : ''}
                {msg.text}
                {msg.imageUrl && (
                  <img src={msg.imageUrl} alt="Generated" className="mt-2 max-w-full rounded border border-green-800" />
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
              <div className="max-w-[80%] break-words whitespace-pre-wrap text-green-500" dir="auto">
                {streamingText}
                <span className="animate-pulse">_</span>
              </div>
            </motion.div>
          )}
          {isProcessing && !isStreaming && (
            <div className="text-green-500 animate-pulse">
              Processing...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {generatedFiles.length > 0 && (
          <div className="absolute bottom-16 right-0 bg-green-900/20 border border-green-500 p-4 rounded backdrop-blur-sm">
            <h3 className="text-sm font-bold mb-2">Ready for Download</h3>
            <p className="text-xs mb-3">{generatedFiles.length} file(s) generated.</p>
            <button 
              onClick={downloadFiles}
              className="flex items-center gap-2 bg-green-600 text-black px-4 py-2 text-sm font-bold hover:bg-green-500 transition-colors"
            >
              <Download className="w-4 h-4" />
              DOWNLOAD PROJECT
            </button>
          </div>
        )}

        <form onSubmit={handleCommand} className="mt-4 flex items-center gap-2 border-t border-green-800 pt-4">
          <span className="text-green-500 font-bold">{user ? 'user@ai-term:~$' : 'guest@ai-term:~$'}</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!user || isProcessing}
            className="flex-1 bg-transparent border-none outline-none text-green-500 placeholder-green-800 font-mono"
            placeholder={user ? "Type a command..." : "Please login to use the terminal"}
            autoFocus
          />
        </form>
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
