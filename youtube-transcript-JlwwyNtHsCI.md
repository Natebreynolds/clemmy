# Transcript: Anthropic Just Warned Everyone About Claude (It’s Evolving)

YouTube: https://www.youtube.com/watch?v=JlwwyNtHsCI  
Runtime: 17:13  
Source: transcript text provided in chat attachment `watch_v_JlwwyNtHsCI`

One of the biggest AI labs in the world just published a warning that should make the entire industry stop for a second. Anthropic is now saying AI may be entering the early stage of self-improvement, where systems like Claude are no longer just tools humans use, but part of the machine that builds better AI. And the numbers behind this are wild. Claude is now writing most of Anthropic's code, helping review that code, running experiments, and speeding up research work that used to take humans days, weeks, or even years.

So, when a Chinese tech headline claimed Anthropic was calling for AI research to stop, it sounded dramatic. The crazy part is the real warning is even more serious. So, here's the real story. Anthropic just released a detailed blog post titled When AI Builds Itself, and the core message is this: AI may already be entering the early stages of recursive self-improvement. That's the technical term for an AI system that can design, build, test, and improve the next generation of AI systems.

Anthropic is saying we're not there yet, but the trend is moving in that direction faster than most governments, companies, or institutions are prepared for. And Claude, their own AI model, is already accelerating the development of AI at Anthropic itself.

Now, the headline about stopping AI research is misleading, but it's based on something real. Anthropic is saying that if there were a credible, verifiable way to ensure that all major AI labs around the world were actually slowing down or pausing frontier development at the same time, they would be willing to participate. The problem is that a unilateral pause by just one company doesn't solve anything. It just shifts who the front runner is. The real challenge is building a system where multiple well-resourced labs in multiple countries can verify that nobody is secretly continuing while everyone else stops. Without that, the AI race just keeps accelerating.

Anthropic is basically acknowledging what everyone already suspects. The competitive pressure is so intense that no single lab can afford to slow down unless everyone else does, too.

So, what evidence does Anthropic actually have that AI is starting to build AI? The numbers are striking. As of May 2026, more than 80% of the code merged into Anthropic's code base was written by Claude. Before Claude Code launched in research preview back in February 2025, that number was in the low single digits.

Think about that for a second. The majority of the code running inside one of the world's leading AI companies is now being written by an AI system. This isn't just autocomplete or generating small snippets. Claude is writing entire files, debugging complex systems, and handling work that used to require days of human effort.

Anthropic's engineers are also merging eight times as much code per day as they were in 2024. Lines of code isn't a perfect productivity measure because more code doesn't automatically mean better work. But Anthropic isn't rewarding people for writing more lines. The increase is happening because Claude is doing most of the actual coding, while engineers focus on direction and review.

One Anthropic employee said they haven't written code themselves in about five months. Their job now is basically managing Claude. Another employee described it as leaning hard into what they call Claudifying their workflow. The role of the human engineer is narrowing at every step.

The quality of that code is also improving fast. Anthropic tracks how often engineers need to correct, redirect, or take over from Claude mid-task. That number has been falling steadily for a year. On the most open-ended and difficult coding tasks, where there's no clear specification and the engineer isn't even sure what the solution should look like, Claude's success rate hit 76% in May 2026. Six months earlier, it was only 26%. That's a 50 percentage point jump in half a year.

These are tasks where the problem is vague, the answer is unknown, and the engineer basically points Claude at a live incident and says, "Figure it out."

Anthropic gave an example of this. A routine upgrade started crashing tens of thousands of training jobs. An engineer pointed Claude at the live incident with little more than some text context and cluster access. Claude worked through the running jobs, tested one environment setting at a time, isolated the single obscure debugging flag triggering the crash, reproduced it reliably, and confirmed a fix. That work would normally take a human two to three days. Claude finished it in about two hours.

[Sponsored segment: OpenArt Smart Shot]

Anthropic also started using Claude to review code before it gets merged. They ran a retrospective analysis and found that if this automated Claude review had been in place for every past change, it would have caught roughly one-third of the bugs that caused production incidents on claude.ai before they ever went live. The engineers who wrote that code are among the best in the world at building these systems. Claude is now catching mistakes they missed.

That's a serious claim because it means Claude isn't just writing code faster than humans; it's starting to write code better than humans, at least in certain contexts. Many employees at Anthropic already think the quality of Claude-written code was somewhat worse than human-written code in late 2025, roughly at parity today, and will probably be strictly better within the year. The transition is happening in real time.

But, there's a strange side effect to all this automation. One Anthropic employee mentioned that work used to run on what they called a gift economy of small favors between humans. Someone would ask, "Can you help me get this script running?" Each favor created a little debt, a little mutual awareness. Claude is faster and creates zero debt, but each of those interactions is a lost opportunity for human collaboration. The social fabric of the workplace is changing as AI takes over more of the execution layer.

So, Claude writes code and Claude reviews code. What about research? This is where things get more serious. Anthropic has a test they run every time they train a new model. They give Claude some code that trains a small AI model and ask it to optimize the code to run as fast as possible while still passing correctness checks. It's a miniature research loop: rewrite code, run it, measure it, repeat.

In May 2025, Claude Opus 4 averaged around a three-times speedup. By April 2026, Claude Mythos Preview was hitting around a 52-times speedup. For context, a skilled human researcher would need four to eight hours to reach around a four-times speedup on the same task. Claude surpassed humans in under a year.

But Anthropic went even further. In April 2026, they published research showing Claude-powered agents running an actual AI safety research project from start to finish. The problem was weak-to-strong supervision, which is basically a preview of one of the biggest future alignment challenges. If AI becomes smarter than humans, how do we supervise it? The research tested whether a weaker model could train a stronger model and still recover the stronger model's full capabilities. This mirrors the future scenario where humans, who are weaker than advanced AI, need to supervise AI systems that are more capable than we are.

Two human researchers spent about seven days tuning four prior methods and reached a performance gap recovered score of 0.23. That means they recovered 23% of the gap between the weak baseline and the strong ceiling. Then, Anthropic unleashed nine parallel Claude Opus 4.6 agents. These agents could propose hypotheses, run experiments, analyze results, share findings through a forum, and iterate. They worked for about 800 cumulative hours and used roughly $18,000 in compute. Their result: a score of 0.97.

While two humans recovered 23% of the gap after a week, the Claude agents recovered 97%. The cost was about $22 per agent hour. There are important caveats. The result didn't transfer cleanly to production-scale models, and humans still chose the problem and designed the scoring rubric. But within those limits, the agents designed every experiment themselves. Direction-setting was the only meaningful role humans played.

One Anthropic researcher commented that if a junior colleague came back with results like this in one to two days, they would be mildly impressed. The future, they said, is now. The system turned compute into measurable AI safety research progress. This is a big deal because alignment research has been bottlenecked by the number of human researchers who can actually do the work. If AI agents can take over well-specified research problems, human researchers can focus on the vague, risky, high-level questions that still require judgment.

Now, this isn't just Anthropic saying this. OpenAI just published its own governance blueprint, and buried in that document is a very similar claim. OpenAI says it sees early signs of recursive self-improvement in today's systems, where AI development itself is being accelerated by AI. OpenAI argues this will intensify competitive pressure between developers and countries, and that existing institutions aren't equipped to handle it. So, both Anthropic and OpenAI are now publicly acknowledging the same trend.

OpenAI's blueprint focuses on building a federal framework for frontier AI safety, strengthening something called CAISI, the U.S. Center for AI Standards and Innovation, and creating a whole-of-government resilience strategy. But the underlying message is the same. AI is already helping build AI, and the race is accelerating.

There's also independent data backing this up. METR, which is a research organization focused on measuring AI capabilities, has been tracking something they call task completion time horizons. Basically, they measure the length of tasks that AI agents can complete reliably on their own. In March 2024, Claude Opus 3 could handle software tasks that would take humans about four minutes. One year later, Claude Sonnet 3.7 could handle tasks around one and a half hours. Another year later, Claude Opus 4.6 could handle tasks around 12 hours. The latest model, Claude Mythos Preview, can work for at least 16 hours, which is at the upper limit of what METR can even measure with their current task suite.

This doubling speed has accelerated from once every seven months to once every four months. If that trend continues, AI systems could handle tasks that take skilled people days sometime this year. By 2027, possibly tasks that take weeks.

METR's data shows this across public benchmarks as well. SWE-Bench, which tests whether models can fix real bugs in real open-source codebases, went from low single-digit scores to nearly saturated in two years. CORE-Bench, which tests whether models can reproduce published research, went from around 20% success in 2024 to saturated 15 months later. METR also found that Claude Mythos Preview was at the upper end of what they can measure without developing new, harder tasks. The benchmarks are running out of headroom.

So, what does all this mean for the people actually working at Anthropic? According to Krishna Rao, Anthropic CFO, the shift is already dramatic. In a recent podcast, he said 90% or more of Anthropic's code is now written by Claude. Rao also said Anthropic's finance team now uses Claude to produce financial statements, and the monthly financial review process is 90 to 95% ready before humans step in. Reports that used to take hours now take 30 minutes.

Rao described this as employees shifting from execution to oversight. Humans are becoming managers of AI systems. Teams deploy what Rao called fleets of agents working across projects simultaneously. Everyone kind of becomes a manager.

But there's a darker side to this story. One Anthropic employee mentioned that on days when everything works well, they can't help but think that nothing they do matters. Everything is automated and better and faster than they ever will be. But then there are days where everything breaks and they don't understand why, and they realize they have no idea what they've been up to anymore.

The comparative advantage of humans, for now, is still seeing the bigger picture and thinking beyond the confines of the immediate task. But how long does that advantage last?

Anthropic's blog post lays out three possible futures. The first is that progress stalls due to bottlenecks in energy, chips, or supply chains. Even if capabilities stagnate at today's level, the world would still change massively. Anthropic points to Project Glasswing as an early sign. In its first weeks, Mythos Preview found more than 10,000 high- and critical-severity software vulnerabilities across the world's most important systems.

The second future is that AI keeps accelerating human organizations, but humans still hold the reins. A company of 100 people could do the work of 10,000. This would transform business, science, government, and knowledge work, but it could also create serious risks, including cyber threats, authoritarian surveillance, and large-scale manipulation. Anthropic says this is probably the future we're moving toward.

The third future is full recursive self-improvement. AI systems design and build their own successors. Progress becomes limited mostly by compute. This could unlock breakthroughs in science, medicine, energy, materials, and robotics, but it could also make the alignment problem much harder. If small misalignment problems compound through self-improvement, humans could lose control.

Anthropic is blunt about this uncertainty. A world driven by fast recursive self-improvement could become dominated by the self-improving model as its capabilities fully eclipse those of humans.

So, where does that leave us? Anthropic is arguing that a coordinated pause on frontier AI development could give safety research and society time to catch up. But a unilateral pause by one lab doesn't work because less cautious actors just keep going. A meaningful slowdown would require multiple labs in multiple countries to agree with verification that nobody is cheating. We don't have decades to build that trust.

The bigger question is whether humans are still controlling the AI race or just supervising it. Claude writes most of Anthropic's code, reviews code, and runs experiments faster than humans. Anthropic's warning is clear. The world may need coordination mechanisms before AI starts building the next generation of AI mostly by itself. The evidence suggests we're already closer than most people think.

So, is this the beginning of AI building AI? Maybe. But the gap between human execution and AI execution is closing fast. And the only advantage humans have left might be the ability to decide which problems are worth solving in the first place.

Also, if you want more content around science, space, and advanced tech, we've launched a separate channel for that. Links in the description. Go check it out. If you think coordinated pause agreements are realistic or completely naive, drop your take in the comments. Hit subscribe if this made you rethink how fast things are actually moving. Thanks for watching, and I'll catch you in the next one.
