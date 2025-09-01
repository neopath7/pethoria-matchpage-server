// AI-Powered Pet Match Bot System
// Uses multiple free AI services with intelligent fallbacks

// API Keys Configuration
window.OPENAI_API_KEY = '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';
window.HUGGINGFACE_API_KEY = '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';
window.COHERE_API_KEY = 'your_cohere_key_here'; // Optional - add if you get one

class PetMatchBot {
  constructor(botProfile) {
    this.profile = botProfile;
    this.conversationHistory = [];
    this.personality = botProfile.personality;
    this.pet = botProfile.pet;
    this.workSchedule = botProfile.workSchedule;
    this.currentMood = this.generateMood();
    this.lastResponse = null;
    this.conversationCount = 0;
  }

  // Generate realistic mood based on time and personality
  generateMood() {
    const hour = new Date().getHours();
    const moods = {
      morning: ['energetic', 'focused', 'optimistic'],
      afternoon: ['friendly', 'social', 'helpful'],
      evening: ['relaxed', 'chatty', 'reflective'],
      night: ['tired', 'quiet', 'thoughtful']
    };

    let timeOfDay;
    if (hour >= 6 && hour < 12) timeOfDay = 'morning';
    else if (hour >= 12 && hour < 18) timeOfDay = 'afternoon';
    else if (hour >= 18 && hour < 22) timeOfDay = 'evening';
    else timeOfDay = 'night';

    return moods[timeOfDay][Math.floor(Math.random() * moods[timeOfDay].length)];
  }

  // Main response generation with multiple AI service fallbacks
  async generateResponse(userMessage, userProfile) {
    this.conversationCount++;
    this.conversationHistory.push({ user: userMessage, timestamp: new Date() });

    try {
      // Try primary AI service (OpenAI API with free tier)
      const response = await this.tryOpenAI(userMessage, userProfile);
      if (response) {
        console.log('✅ OpenAI response generated');
        return response;
      }
    } catch (error) {
      console.log('⚠️ OpenAI failed, trying fallback...');
    }

    try {
      // Try secondary AI service (Hugging Face free inference)
      const response = await this.tryHuggingFace(userMessage, userProfile);
      if (response) {
        console.log('✅ Hugging Face response generated');
        return response;
      }
    } catch (error) {
      console.log('⚠️ Hugging Face failed, trying fallback...');
    }

    try {
      // Try tertiary AI service (Cohere free tier)
      const response = await this.tryCohere(userMessage, userProfile);
      if (response) {
        console.log('✅ Cohere response generated');
        return response;
      }
    } catch (error) {
      console.log('⚠️ Cohere failed, using rule-based fallback...');
    }

    // Final fallback: Rule-based responses
    console.log('✅ Using rule-based fallback');
    return this.generateRuleBasedResponse(userMessage, userProfile);
  }

  // OpenAI API (Free tier: 3 requests/minute)
  async tryOpenAI(userMessage, userProfile) {
    if (!window.OPENAI_API_KEY) return null;
    
    try {
      const prompt = this.buildPrompt(userMessage, userProfile);
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${window.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: `You are ${this.profile.name}, a ${this.personality} person with a ${this.pet.type} named ${this.pet.name}. ${this.pet.description}. You're always busy with work but love chatting about pets. Keep responses under 100 words, be friendly but mention work commitments when asked to meet.`
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: 150,
          temperature: 0.8
        })
      });

      if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content;
      } else {
        console.error('OpenAI API error:', response.status, response.statusText);
      }
    } catch (error) {
      console.error('OpenAI error:', error);
    }
    return null;
  }

  // Hugging Face Inference API (Free tier: 30,000 requests/month)
  async tryHuggingFace(userMessage, userProfile) {
    if (!window.HUGGINGFACE_API_KEY) return null;
    
    try {
      const prompt = this.buildPrompt(userMessage, userProfile);
      
      // Use Hugging Face Inference API with better model
      const response = await fetch('https://api-inference.huggingface.co/models/microsoft/DialoGPT-medium', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${window.HUGGINGFACE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            max_length: 100,
            temperature: 0.8,
            do_sample: true,
            return_full_text: false
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data && data[0] && data[0].generated_text) {
          return this.postProcessHuggingFaceResponse(data[0].generated_text);
        }
      } else {
        console.error('Hugging Face API error:', response.status, response.statusText);
      }
    } catch (error) {
      console.error('Hugging Face error:', error);
    }
    return null;
  }

  // Cohere API (Free tier: 5 requests/minute)
  async tryCohere(userMessage, userProfile) {
    if (!window.COHERE_API_KEY || window.COHERE_API_KEY === 'your_cohere_key_here') return null;
    
    try {
      const prompt = this.buildPrompt(userMessage, userProfile);
      const response = await fetch('https://api.cohere.ai/v1/generate', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${window.COHERE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'command',
          prompt: prompt,
          max_tokens: 100,
          temperature: 0.8,
          k: 0,
          stop_sequences: ['\n', '.', '!', '?']
        })
      });

      if (response.ok) {
        const data = await response.json();
        return data.generations[0].text.trim();
      } else {
        console.error('Cohere API error:', response.status, response.statusText);
      }
    } catch (error) {
      console.error('Cohere error:', error);
    }
    return null;
  }

  // Rule-based fallback system
  generateRuleBasedResponse(userMessage, userProfile) {
    const message = userMessage.toLowerCase();
    const responses = this.getResponseTemplates();

    // Check for specific patterns
    if (message.includes('meet') || message.includes('playdate') || message.includes('coffee')) {
      return this.generateWorkExcuse();
    }

    if (message.includes('pet') || message.includes('dog') || message.includes('cat')) {
      return this.generatePetResponse();
    }

    if (message.includes('work') || message.includes('busy') || message.includes('schedule')) {
      return this.generateWorkResponse();
    }

    if (message.includes('how are you') || message.includes('feeling')) {
      return this.generateMoodResponse();
    }

    // Default friendly response
    return this.generateDefaultResponse();
  }

  // Build context-aware prompt for AI services
  buildPrompt(userMessage, userProfile) {
    const context = `
Context: You are ${this.profile.name}, a ${this.personality} person with a ${this.pet.type} named ${this.pet.name}.
Pet details: ${this.pet.description}
Your personality: ${this.personality}
Current mood: ${this.currentMood}
Work schedule: ${this.workSchedule}
User message: ${userMessage}
User profile: ${userProfile.name || 'User'} with ${userProfile.petType || 'pet'}

Respond as ${this.profile.name} would naturally, being friendly but mentioning work commitments when asked to meet. Keep it under 100 words and authentic to your personality.
`;

    return context;
  }

  // Response templates for different scenarios
  getResponseTemplates() {
    return {
      greetings: [
        `Hey there! ${this.pet.name} and I are having a great day! How about you?`,
        `Hi! Just finished walking ${this.pet.name} - he's such a bundle of energy!`,
        `Hello! ${this.pet.name} says hi too! 🐾`
      ],
      petChat: [
        `${this.pet.name} is absolutely adorable! ${this.pet.description}`,
        `I love talking about ${this.pet.name}! He's my little buddy.`,
        `${this.pet.name} is the best thing that happened to me!`
      ],
      workExcuses: [
        `I'd love to meet up, but I'm swamped with work this week. Maybe next time?`,
        `Work is crazy busy right now, but ${this.pet.name} and I would love to plan something soon!`,
        `I'm in the middle of a big project, but let's definitely plan a playdate when things calm down!`
      ]
    };
  }

  // Generate work-related excuses
  generateWorkExcuse() {
    const excuses = [
      `I'd love to meet up! But I'm actually in the middle of a big work project right now. ${this.pet.name} and I are free next weekend though!`,
      `That sounds fun! Unfortunately I'm swamped with work this week. Maybe we could plan something for next week?`,
      `I'm so busy with work lately, but ${this.pet.name} and I would love to meet up when things calm down!`
    ];
    return excuses[Math.floor(Math.random() * excuses.length)];
  }

  // Generate pet-related responses
  generatePetResponse() {
    const responses = [
      `${this.pet.name} is amazing! ${this.pet.description} He's my little best friend.`,
      `I love talking about ${this.pet.name}! He's such a character. ${this.pet.description}`,
      `${this.pet.name} is the highlight of my day! ${this.pet.description}`
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  // Generate work-related responses
  generateWorkResponse() {
    const responses = [
      `Work is pretty busy right now, but ${this.pet.name} helps me stay sane! How about you?`,
      `I'm working on some interesting projects. ${this.pet.name} is my stress relief buddy!`,
      `Work keeps me busy, but I always make time for ${this.pet.name}!`
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  // Generate mood-based responses
  generateMoodResponse() {
    const moodResponses = {
      energetic: `I'm feeling great! ${this.pet.name} and I just had an amazing morning walk!`,
      focused: `Pretty focused on work today, but ${this.pet.name} keeps me grounded!`,
      friendly: `I'm in a great mood! ${this.pet.name} is being extra cuddly today.`,
      social: `Feeling super social! ${this.pet.name} and I love meeting new people!`,
      relaxed: `Pretty relaxed today. ${this.pet.name} and I are just chilling.`,
      chatty: `I'm feeling chatty! ${this.pet.name} is a great listener too!`,
      reflective: `Feeling thoughtful today. ${this.pet.name} always knows how to cheer me up.`,
      tired: `A bit tired from work, but ${this.pet.name} is keeping me company!`,
      quiet: `Feeling quiet today, but ${this.pet.name} understands.`,
      thoughtful: `In a thoughtful mood. ${this.pet.name} is my best thinking partner!`
    };
    return moodResponses[this.currentMood] || moodResponses.friendly;
  }

  // Generate default friendly response
  generateDefaultResponse() {
    const defaults = [
      `That's interesting! ${this.pet.name} and I would love to hear more about that.`,
      `Thanks for sharing! ${this.pet.name} is nodding along too! 🐾`,
      `That's cool! ${this.pet.name} and I are always up for good conversation.`,
      `Interesting! ${this.pet.name} is my conversation buddy too!`
    ];
    return defaults[Math.floor(Math.random() * defaults.length)];
  }

  // Post-process Hugging Face responses
  postProcessHuggingFaceResponse(response) {
    // Clean up the response and make it more natural
    let cleaned = response.replace(/^.*?bot:/i, '').trim();
    cleaned = cleaned.replace(/^.*?user:/i, '').trim();
    cleaned = cleaned.replace(/^.*?assistant:/i, '').trim();
    
    // Add personality and context
    if (cleaned.length < 20) {
      cleaned = this.generateDefaultResponse();
    }
    
    return cleaned;
  }

  // Update bot state
  updateState() {
    this.currentMood = this.generateMood();
    this.conversationCount++;
  }

  // Get bot statistics
  getStats() {
    return {
      name: this.profile.name,
      petName: this.pet.name,
      petType: this.pet.type,
      personality: this.personality,
      currentMood: this.currentMood,
      conversationCount: this.conversationCount,
      lastActive: new Date().toISOString()
    };
  }
}

// Bot Profile Database
const BOT_PROFILES = [
  {
    id: 'bot_001',
    name: 'Sarah',
    age: 28,
    personality: 'outgoing and energetic',
    pet: {
      name: 'Max',
      type: 'Golden Retriever',
      description: 'He\'s a 3-year-old golden retriever who loves playing fetch and going to the dog park. He\'s super friendly with other dogs and kids!'
    },
    workSchedule: 'I work as a marketing manager, usually 9-6 but sometimes have evening meetings.',
    location: 'Downtown area',
    interests: ['hiking', 'coffee shops', 'dog parks', 'photography'],
    photos: ['https://images.unsplash.com/photo-1494790108755-2616b612b786?w=400', 'https://images.unsplash.com/photo-1552053831-71594a27632d?w=400']
  },
  {
    id: 'bot_002',
    name: 'Alex',
    age: 31,
    personality: 'laid-back and friendly',
    pet: {
      name: 'Luna',
      type: 'Siamese Cat',
      description: 'She\'s a 2-year-old Siamese cat who\'s very vocal and loves sitting in sunny spots. She\'s curious about other pets but takes time to warm up.'
    },
    workSchedule: 'I\'m a software developer, so I work from home most days but have flexible hours.',
    location: 'Westside neighborhood',
    interests: ['gaming', 'tech', 'cooking', 'cat cafes'],
    photos: ['https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400', 'https://images.unsplash.com/photo-1513360371669-4adf3dd7dff8?w=400']
  },
  {
    id: 'bot_003',
    name: 'Emma',
    age: 26,
    personality: 'creative and adventurous',
    pet: {
      name: 'Rocky',
      type: 'Border Collie',
      description: 'He\'s a 4-year-old border collie who\'s incredibly smart and loves learning new tricks. He needs lots of mental stimulation and exercise!'
    },
    workSchedule: 'I\'m a graphic designer, so my schedule varies but I usually work 10-7.',
    location: 'Arts district',
    interests: ['art', 'hiking', 'dog training', 'coffee'],
    photos: ['https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400', 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=400']
  },
  {
    id: 'bot_004',
    name: 'Mike',
    age: 29,
    personality: 'sporty and competitive',
    pet: {
      name: 'Bella',
      type: 'Australian Shepherd',
      description: 'She\'s a 2-year-old Aussie who\'s full of energy and loves agility training. She\'s super fast and loves playing with other active dogs!'
    },
    workSchedule: 'I work as a personal trainer, so my hours are early mornings and evenings.',
    location: 'Sports complex area',
    interests: ['fitness', 'running', 'dog sports', 'outdoor activities'],
    photos: ['https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400', 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?w=400']
  },
  {
    id: 'bot_005',
    name: 'Jessica',
    age: 27,
    personality: 'nurturing and patient',
    pet: {
      name: 'Oliver',
      type: 'Persian Cat',
      description: 'He\'s a 5-year-old Persian cat who\'s very calm and loves being brushed. He\'s great with other pets and loves attention.'
    },
    workSchedule: 'I\'m a nurse, so I work 12-hour shifts but get several days off in a row.',
    location: 'Hospital district',
    interests: ['reading', 'yoga', 'pet grooming', 'gardening'],
    photos: ['https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400', 'https://images.unsplash.com/photo-1518791845787-1c0b568bcd1b?w=400']
  },
  {
    id: 'bot_006',
    name: 'David',
    age: 32,
    personality: 'intellectual and curious',
    pet: {
      name: 'Athena',
      type: 'Maine Coon',
      description: 'She\'s a 3-year-old Maine Coon who\'s very intelligent and loves puzzle toys. She\'s friendly but also independent.'
    },
    workSchedule: 'I\'m a research scientist, so my hours are flexible but I often work late on experiments.',
    location: 'University area',
    interests: ['science', 'reading', 'puzzles', 'nature walks'],
    photos: ['https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=400', 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=400']
  }
];

// Bot Manager Class
class BotManager {
  constructor() {
    this.bots = new Map();
    this.activeBots = new Set();
    this.initializeBots();
  }

  initializeBots() {
    BOT_PROFILES.forEach(profile => {
      this.bots.set(profile.id, new PetMatchBot(profile));
    });
  }

  // Get a random bot for matching
  getRandomBot() {
    const botIds = Array.from(this.bots.keys());
    const randomId = botIds[Math.floor(Math.random() * botIds.length)];
    return this.bots.get(randomId);
  }

  // Get bot by ID
  getBot(botId) {
    return this.bots.get(botId);
  }

  // Get all available bots
  getAllBots() {
    return Array.from(this.bots.values());
  }

  // Activate a bot for conversation
  activateBot(botId) {
    const bot = this.bots.get(botId);
    if (bot) {
      this.activeBots.add(botId);
      bot.updateState();
    }
    return bot;
  }

  // Deactivate a bot
  deactivateBot(botId) {
    this.activeBots.delete(botId);
  }

  // Get conversation suggestions for a bot
  getConversationStarters(botId) {
    const bot = this.bots.get(botId);
    if (!bot) return [];

    const starters = [
      `Hi ${bot.profile.name}! How's ${bot.pet.name} doing today?`,
      `Hey! I love ${bot.pet.type}s. Tell me about ${bot.pet.name}!`,
      `Hi there! What's your favorite thing about having ${bot.pet.name}?`,
      `Hello! I'm curious about your pet. What's ${bot.pet.name} like?`,
      `Hey ${bot.profile.name}! What's the best part of your day with ${bot.pet.name}?`
    ];

    return starters;
  }

  // Get bot statistics
  getBotStats() {
    const stats = {};
    this.bots.forEach((bot, id) => {
      stats[id] = bot.getStats();
    });
    return stats;
  }
}

// Export for use in other files
window.PetMatchBot = PetMatchBot;
window.BotManager = BotManager;
window.BOT_PROFILES = BOT_PROFILES;
