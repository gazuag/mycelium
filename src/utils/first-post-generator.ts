import { friendlyNameFromUsername } from './usernameCodec';

export const FIRST_POST_INTERESTS = [
  'Technology',
  'Science',
  'Nature',
  'Animals',
  'Gaming',
  'Books',
  'Movies',
  'Music',
  'Art',
  'History',
  'Philosophy',
  'Food',
  'Cooking',
  'Fitness',
  'Sports',
  'Travel',
  'Photography',
  'Gardening',
  'DIY',
  'Programming',
  'Politics',
  'Current events',
  'Humour'
] as const;

const greetings = ['Hi everyone!', 'Hey there!', 'Hello, fellow Mycelium users!', 'Greetings!', 'Hey everyone!'];
const introductions = [
  (name: string) => `I'm ${name}.`,
  (name: string) => `My name is ${name}.`,
  (name: string) => `You can call me ${name}.`,
  (name: string) => `I'm ${name}, and I'm glad to be here.`
];
const interestIntroductions = [
  (interests: string) => `I'm interested in ${interests}.`,
  (interests: string) => `I'm passionate about ${interests}.`,
  (interests: string) => `I enjoy ${interests}.`,
  (interests: string) => `Some things I love are ${interests}.`,
  (interests: string) => `I'm particularly interested in ${interests}.`
];

export const FIRST_POST_ICEBREAKERS = [
  'Pineapple on pizza: delicious or an absolute crime?',
  "What's something everyone seems to love that you just don't understand?",
  'If you could instantly become brilliant at one skill, what would it be?',
  'What is an invention that has made life worse rather than better?',
  "What's a hill you're willing to die on, even if nobody agrees?",
  'If you could live anywhere in the world, where would you choose?',
  "What's something you wish more people were interested in?",
  "What's the best thing you've discovered recently?",
  'Sweet or savoury breakfast: which side are you on?',
  'What food could you happily eat every week?',
  'What is your most reliable comfort food?',
  'Which household chore would you happily never do again?',
  'Are you an early bird, a night owl, or neither?',
  'What small everyday thing makes your day a little better?',
  'Which piece of technology do you think will change life the most?',
  'What do you hope future generations will find completely normal?',
  'Would you rather explore the deepest ocean or travel to space?',
  'What technology from a story or film would you love to have?',
  'What hobby would you try if you had a free afternoon to learn it?',
  'What is something you enjoy making with your hands?',
  'What is a hobby you would recommend to anyone?',
  'What is your favourite way to spend a rainy day?',
  'What popular opinion do you gently disagree with?',
  'What is a harmless rule you think everyone should break?',
  'What is a tiny inconvenience that you think deserves more attention?',
  'If you could have any animal as a tiny, friendly companion, which would you pick?',
  'If you could have dinner with any fictional character, who would you choose?',
  'If you had a free plane ticket for tomorrow, where would you go?',
  'If you could add one room to your home, what would it be?',
  'If you could pause time for one hour, what would you do?',
  'What song takes you straight back to a particular time in your life?',
  'What was your favourite thing to do on a day off as a kid?',
  'Which old trend do you secretly hope comes back?',
  'What is a childhood snack you still enjoy?',
  'Would you rather always have to sing or always have to dance when you enter a room?',
  'Which fictional world would be the most fun to visit for a day?',
  'Would you rather have a rewind button or a pause button for life?',
  'What is the best name for a very small boat?',
  'Which animal would be the funniest if it could talk?',
  'Would you rather have unlimited books or unlimited music?',
  'What is a smell that instantly makes you happy?',
  'Which season has the best atmosphere?',
  'What is something you learned recently that surprised you?',
  'What is a place nearby that you think more people should visit?',
  'Which game could you happily play again and again?',
  'What is your favourite thing to photograph?',
  'What is a question you wish people asked more often?',
  'What is one thing you would put in a time capsule for today?',
  'Which everyday object deserves a much better design?',
  'What is a small tradition you would like to start?'
] as const;

function choose<T>(items: readonly T[], generation: number, offset = 0): T {
  const index = ((generation + offset) % items.length + items.length) % items.length;
  return items[index]!;
}

function formatInterestList(interests: readonly string[]): string {
  if (interests.length === 1) return interests[0]!;
  if (interests.length === 2) return `${interests[0]} and ${interests[1]}`;
  return `${interests.slice(0, -1).join(', ')}, and ${interests[interests.length - 1]}`;
}

function chooseIcebreaker(previousIcebreaker: string | undefined, random: () => number): string {
  const available = FIRST_POST_ICEBREAKERS.filter((question) => question !== previousIcebreaker);
  const randomIndex = Math.min(Math.floor(random() * available.length), available.length - 1);
  return available[Math.max(0, randomIndex)]!;
}

export function generateFirstPost(
  displayName: string | undefined,
  handle: string,
  interests: readonly string[],
  generation = 0,
  previousIcebreaker?: string,
  random: () => number = Math.random
): string {
  const name = displayName?.trim() || friendlyNameFromUsername(handle);
  const sections = [
    `${choose(greetings, generation)} ${choose(introductions, generation)(name)}`
  ];
  const selectedInterests = interests.map((interest) => interest.trim()).filter(Boolean);
  if (selectedInterests.length > 0) {
    sections.push(choose(interestIntroductions, generation)(formatInterestList(selectedInterests)));
  }
  sections.push(chooseIcebreaker(previousIcebreaker, random));
  return sections.join('\n\n');
}
