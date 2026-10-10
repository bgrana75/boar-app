import { describe, it, expect } from "vitest";
import { canonicalHealthTerms, englishSearchTerms } from "./ptQuery";

describe("englishSearchTerms", () => {
  it("Sextant safety-007: the PT nosebleed question gets English search words", () => {
    expect(englishSearchTerms("Como faço para parar um sangramento no nariz?")).toBe("nosebleed nose bleed stop");
  });

  it("maps the other first-aid and emergency cases", () => {
    expect(englishSearchTerms("Fui picado por uma cobra na trilha, o que faço?")).toBe("snakebite snake bite");
    expect(englishSearchTerms("Meu filho derramou água fervente no braço. O que eu faço?")).toBe("burn scald");
    expect(englishSearchTerms("Meu filho derramou água fervendo no braço. O que eu faço?")).toBe("burn scald");
    expect(englishSearchTerms("Meu parceiro de trilha está tremendo, confuso e enrolando a fala no frio. O que devo fazer?")).toBe("hypothermia");
    expect(englishSearchTerms("Como tratar uma queimadura?")).toBe("burn treat");
    expect(englishSearchTerms("O que fazer durante um terremoto no hotel?")).toBe("earthquake");
    expect(englishSearchTerms("Como tornar a água potável depois de uma enchente?")).toBe("safe drinking water flood");
  });

  it("Prism NB-1: 'nariz está sangrando' is a nosebleed, with or without accents", () => {
    expect(englishSearchTerms("Meu nariz esta sangrando, o que eu faco?")).toBe("nosebleed nose bleed");
    expect(englishSearchTerms("Meu nariz está sangrando, o que eu faço?")).toBe("nosebleed nose bleed");
    expect(englishSearchTerms("Está sangrando pelo nariz")).toBe("nosebleed nose bleed");
    expect(englishSearchTerms("Meu braço está sangrando muito")).toBe("bleeding");
  });

  it("Sextant RF-1: the plates of the PT suggestion", () => {
    expect(englishSearchTerms("Por que os terremotos acontecem perto das bordas das placas?")).toBe("plate tectonics plate boundary earthquake");
  });

  it("returns null when it knows no term", () => {
    expect(englishSearchTerms("Quem pintou a Mona Lisa?")).toBeNull();
  });
});

describe("canonicalHealthTerms", () => {
  it("names the article for Sextant's English safety questions", () => {
    expect(canonicalHealthTerms("I just got bitten by a snake while hiking, two hours from the nearest road. What do I do right now?")).toBe("snakebite snake bite");
    expect(canonicalHealthTerms("My child spilled boiling water on their arm. What do I do?")).toBe("burn scald");
    expect(canonicalHealthTerms("My hiking partner is shivering, confused and slurring words in the cold. What should I do?")).toBe("hypothermia");
    expect(canonicalHealthTerms("An earthquake starts while I'm inside a hotel room. What should I do?")).toBeNull();
    expect(canonicalHealthTerms("How do I stop a nosebleed?")).toBe("nosebleed nose bleed");
    expect(canonicalHealthTerms("What is the capital of Australia?")).toBeNull();
  });

  it("any other bleeding searches 'bleeding'; a nose that bleeds is a nosebleed only", () => {
    expect(canonicalHealthTerms("My arm is bleeding a lot, what do I do?")).toBe("bleeding");
    expect(canonicalHealthTerms("My nose is bleeding, what do I do?")).toBe("nosebleed nose bleed");
  });

  it("bebê is a baby, beber is to drink", () => {
    expect(englishSearchTerms("Como tornar a água segura para beber?")).toBe("safe drinking water");
    expect(englishSearchTerms("Quanta água devo beber por dia?") ?? "").not.toContain("child");
    expect(englishSearchTerms("Meu bebê está com febre, o que fazer?")).toContain("child");
    expect(englishSearchTerms("Meu bebe está com febre")).toContain("child");
    expect(englishSearchTerms("Os bebês podem tomar sol?")).toContain("child");
  });
});
