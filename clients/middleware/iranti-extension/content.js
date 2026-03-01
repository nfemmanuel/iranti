// Iranti Memory Extension
// Adds persistent memory to Claude and ChatGPT

const IRANTI_URL = 'http://localhost:3001';
const IRANTI_API_KEY = 'dev_test_key_12345';
const AGENT_ID = 'browser_assistant';

// Intercept fetch() calls
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const [url, options] = args;
  
  // Detect Claude API call
  if (url.includes('api.anthropic.com/v1/messages') || 
      url.includes('claude.ai/api/organizations')) {
    return await handleClaudeRequest(url, options);
  }
  
  // Detect ChatGPT API call
  if (url.includes('chat.openai.com/backend-api/conversation')) {
    return await handleChatGPTRequest(url, options);
  }
  
  // Pass through other requests
  return originalFetch.apply(this, args);
};

async function handleClaudeRequest(url, options) {
  try {
    const body = JSON.parse(options.body);
    const messages = body.messages || [];
    
    // Get last user message
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMsg) {
      return originalFetch(url, options);
    }
    
    // Build context from conversation
    const context = messages.map(m => {
      const content = typeof m.content === 'string' ? m.content : 
                     Array.isArray(m.content) ? m.content.map(c => c.text || '').join(' ') : '';
      return `${m.role}: ${content}`;
    }).join('\n');
    
    // Call Iranti observe()
    const observeResponse = await originalFetch(`${IRANTI_URL}/observe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Iranti-Key': IRANTI_API_KEY
      },
      body: JSON.stringify({
        agentId: AGENT_ID,
        currentContext: context,
        maxFacts: 5
      })
    });
    
    if (observeResponse.ok) {
      const { facts } = await observeResponse.json();
      
      // Inject facts into last user message
      if (facts && facts.length > 0) {
        const factText = facts.map(f => f.summary).join('; ');
        const originalContent = typeof lastUserMsg.content === 'string' ? 
          lastUserMsg.content : 
          lastUserMsg.content[0]?.text || '';
        
        const augmentedContent = `[MEMORY: ${factText}]\n\n${originalContent}`;
        
        if (typeof lastUserMsg.content === 'string') {
          lastUserMsg.content = augmentedContent;
        } else if (Array.isArray(lastUserMsg.content)) {
          lastUserMsg.content[0].text = augmentedContent;
        }
        
        // Update request body
        options.body = JSON.stringify(body);
        
        console.log('[Iranti] Injected', facts.length, 'facts');
      }
    }
  } catch (error) {
    console.error('[Iranti] Error:', error);
  }
  
  // Send modified request
  return originalFetch(url, options);
}

async function handleChatGPTRequest(url, options) {
  try {
    const body = JSON.parse(options.body);
    const messages = body.messages || [];
    
    // Get last user message
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMsg) {
      return originalFetch(url, options);
    }
    
    // Build context
    const context = messages.map(m => {
      const content = m.content?.parts ? m.content.parts.join(' ') : m.content || '';
      return `${m.author?.role || m.role}: ${content}`;
    }).join('\n');
    
    // Call Iranti observe()
    const observeResponse = await originalFetch(`${IRANTI_URL}/observe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Iranti-Key': IRANTI_API_KEY
      },
      body: JSON.stringify({
        agentId: AGENT_ID,
        currentContext: context,
        maxFacts: 5
      })
    });
    
    if (observeResponse.ok) {
      const { facts } = await observeResponse.json();
      
      // Inject facts
      if (facts && facts.length > 0) {
        const factText = facts.map(f => f.summary).join('; ');
        
        if (lastUserMsg.content?.parts) {
          const originalContent = lastUserMsg.content.parts[0];
          lastUserMsg.content.parts[0] = `[MEMORY: ${factText}]\n\n${originalContent}`;
        } else if (typeof lastUserMsg.content === 'string') {
          lastUserMsg.content = `[MEMORY: ${factText}]\n\n${lastUserMsg.content}`;
        }
        
        options.body = JSON.stringify(body);
        
        console.log('[Iranti] Injected', facts.length, 'facts');
      }
    }
  } catch (error) {
    console.error('[Iranti] Error:', error);
  }
  
  return originalFetch(url, options);
}

console.log('[Iranti] Memory extension loaded');
