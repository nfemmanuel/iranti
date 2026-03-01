// Iranti Memory Extension - inject into page context
(function() {
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      const IRANTI_URL = 'http://localhost:3001';
      const IRANTI_API_KEY = 'dev_test_key_12345';
      const AGENT_ID = 'browser_assistant';
      
      console.log('[Iranti] Loading on', window.location.hostname);
      
      const originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const [url, options] = args;
        
        // Claude API
        if (url.includes('/api/append_message') || url.includes('/api/organizations')) {
          console.log('[Iranti] Claude API detected');
          return await handleClaudeRequest(url, options);
        }
        
        return originalFetch.apply(this, args);
      };

      async function handleClaudeRequest(url, options) {
        try {
          const body = JSON.parse(options.body);
          const prompt = body.prompt;
          
          if (!prompt) {
            return originalFetch(url, options);
          }
          
          console.log('[Iranti] Calling observe()...');
          const resp = await originalFetch(\`\${IRANTI_URL}/observe\`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Iranti-Key': IRANTI_API_KEY
            },
            body: JSON.stringify({
              agentId: AGENT_ID,
              currentContext: prompt.substring(0, 3000),
              maxFacts: 5
            })
          });
          
          if (resp.ok) {
            const { facts } = await resp.json();
            console.log('[Iranti] Facts:', facts.length);
            
            if (facts && facts.length > 0) {
              const factText = facts.map(f => f.summary).join('; ');
              body.prompt = \`[MEMORY: \${factText}]\\n\\n\${prompt}\`;
              options.body = JSON.stringify(body);
              console.log('[Iranti] ✓ Injected', facts.length, 'facts');
            }
          }
        } catch (error) {
          console.error('[Iranti] Error:', error);
        }
        
        return originalFetch(url, options);
      }
      
      console.log('[Iranti] ✓ Ready');
    })();
  `;
  
  (document.head || document.documentElement).appendChild(script);
  script.remove();
})();
