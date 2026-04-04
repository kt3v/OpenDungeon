import type { CharacterTemplate } from "@opendungeon/content-sdk";

export const characterClasses: Record<string, CharacterTemplate> = {
  Ranger: {
    level: 1,
    hp: 110,
    attributes: { agility: 12, strength: 10, intellect: 8 }
  },
  Mage: {
    level: 1,
    hp: 80,
    attributes: { agility: 8, strength: 7, intellect: 14 }
  },
  Warrior: {
    level: 1,
    hp: 130,
    attributes: { agility: 8, strength: 14, intellect: 6 }
  }
};

export const availableClasses = Object.keys(characterClasses);

export const fallbackClass: CharacterTemplate = {
  level: 1,
  hp: 100,
  attributes: { agility: 10, strength: 10, intellect: 10 }
};

export const getCharacterTemplate = (className: string): CharacterTemplate =>
  characterClasses[className] ?? fallbackClass;
