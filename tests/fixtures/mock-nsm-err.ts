
      const reader = Bun.stdin.stream().getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffered.indexOf("\n");
          if (nl === -1) break;
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          const id = line.split(" ")[0];
          process.stdout.write(id + " ERR simulated_failure\n");
        }
      }
    