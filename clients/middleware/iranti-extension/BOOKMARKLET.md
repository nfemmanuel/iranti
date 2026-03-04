# Iranti Bookmarklet - Simple Alternative to Extension

Since ChatGPT blocks content scripts, use this bookmarklet instead:

## Setup (One Time)

1. Create a new bookmark in Chrome (Ctrl+D on any page)
2. Name it: `Iranti Memory`
3. Paste this as the URL:

```javascript
javascript:(function(){const s=document.createElement('script');s.src='http://localhost:3001/bookmarklet.js';document.head.appendChild(s);})();
```

## Even Simpler: Direct Test

Or just paste this in the Console (F12) on ChatGPT:

```javascript
// Test if we can intercept fetch
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  console.log('[Iranti Test] Fetch called:', args[0]);
  return originalFetch.apply(this, args);
};
console.log('[Iranti Test] Interceptor installed. Send a message in ChatGPT.');
```

Then send a message in ChatGPT and watch the console.

## Full Working Version (Paste in Console)

```javascript
(async function() {
  const IRANTI_URL = 'http://localhost:3001';
  const IRANTI_API_KEY = 'dev_test_key_12345';
  
  console.log('[Iranti] Installing memory interceptor...');
  
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const [url, options] = args;
    
    if (url.includes('backend-api/conversation')) {
      console.log('[Iranti] ChatGPT API call detected');
      
      try {
        const body = JSON.parse(options.body);
        const messages = body.messages || [];
        const lastMsg = messages[messages.length - 1];
        
        if (lastMsg && lastMsg.content) {
          console.log('[Iranti] User message:', lastMsg.content.parts[0].substring(0, 50) + '...');
          
          // Call observe
          const context = messages.map(m => 
            `${m.author.role}: ${m.content.parts.join(' ')}`
          ).join('\n');
          
          const resp = await originalFetch(`${IRANTI_URL}/memory/observe`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Iranti-Key': IRANTI_API_KEY
            },
            body: JSON.stringify({
              agentId: 'browser_assistant',
              currentContext: context,
              maxFacts: 5
            })
          });
          
          if (resp.ok) {
            const { facts } = await resp.json();
            console.log('[Iranti] Facts from memory:', facts.length);
            
            if (facts.length > 0) {
              const factText = facts.map(f => f.summary).join('; ');
              const original = lastMsg.content.parts[0];
              lastMsg.content.parts[0] = `[MEMORY: ${factText}]\n\n${original}`;
              options.body = JSON.stringify(body);
              console.log('[Iranti] ✓ Injected', facts.length, 'facts');
            }
          }
        }
      } catch (e) {
        console.error('[Iranti] Error:', e);
      }
    }
    
    return originalFetch.apply(this, args);
  };
  
  console.log('[Iranti] ✓ Ready. Send a message to test.');
})();
```

## Test It

1. Open ChatGPT
2. Open Console (F12)
3. Paste the "Full Working Version" code above
4. Press Enter
5. You should see: `[Iranti] ✓ Ready. Send a message to test.`
6. Send any message in ChatGPT
7. Watch console for `[Iranti] ChatGPT API call detected`

This works because you're running it directly in the page context, not as a content script.
