# The Unkept Life

### A research report on the cognitive burden of personal life administration, the failure modes of existing tools, and the case for a private, on-device system of record

Veyago Inc. · Project: Kept · June 2026 · Working paper

---

## Abstract

Personal life administration, meaning the ongoing work of keeping track of warranties, receipts, important documents and identity papers, subscriptions, renewals, and the expiry dates of things like food and medicine, is a real and measurable burden that sits almost entirely on the individual and is poorly served by the tools people currently use. This report assembles the public evidence on the scale and shape of that burden, draws on the sociological literature that frames it as invisible cognitive labour rather than a trivial chore, and then offers an original structural analysis of why the problem persists. The central finding is that the failure is not one of effort or discipline but of architecture: the records that govern a person's obligations are scattered across many systems, none of which is a trusted single home, the consequences of losing track are delayed and asymmetric, nothing surfaces an obligation before it lapses, and the one design that would solve the unification problem, a single aggregating service, runs directly into a privacy constraint because the data involved is unusually sensitive. The report argues that these constraints point to a specific and presently buildable answer, namely a private system of record that lives on the person's own device, processes their information locally, charges once rather than recurring, organises items under the real-world entities they belong to, and offers an assistant that prepares administrative actions for a human to approve rather than acting on its own. It closes with the open questions this thesis raises and a transparent account of its own evidentiary limits. Where the report cites figures, those figures come from named third-party surveys and market studies and should be read with the methodological caveats set out at the end. Kept is the product being designed in response to this analysis, and the claims here are hypotheses the product is built to test rather than outcomes it has demonstrated.

---

## 1. Introduction: taking life admin seriously

Most people would describe the work of remembering to cancel a free trial, finding the receipt for a broken appliance, or renewing a passport before a trip as minor and faintly embarrassing rather than as a subject worth studying. That intuition is precisely the problem this report sets out to correct, because the evidence shows that the accumulated weight of this work is neither minor nor evenly distributed, and that the reason it feels trivial is the same reason it goes unmanaged. It is invisible. It happens in the background of a life, it produces no artifact when it is done well, and its costs arrive late and in forms that are easy to attribute to bad luck rather than to a missing system.

The domain this report concerns itself with is personal life administration in the narrow sense, meaning the tracking and timely handling of obligations and records that attach to the things a person owns and the commitments a person has made. This is distinct from physical chores such as cooking or cleaning, and it is distinct from large deliberate financial decisions such as buying a house or choosing an investment. It is the connective administrative tissue underneath ordinary life: the warranty that is worthless without the receipt, the subscription that renews silently, the document that expires on a date no one is watching, the medicine in the cabinet that is already out of date. The argument of this report is that this tissue is a legitimate object of product design, that the tools people currently reach for fail it in structurally predictable ways, and that recent changes in what a personal device can do locally have, for the first time, made a genuinely private solution possible.

## 2. The cognitive frame: life admin as invisible labour

The most useful lens for understanding why life administration is burdensome comes not from product research but from sociology, where the work of running a household has been studied carefully enough to separate its visible physical component from its invisible mental one. The sociologist Allison Daminger, in widely cited 2019 work on the cognitive dimension of household labour, decomposed this mental work into four recurring acts: anticipating a need before it becomes urgent, identifying the options for meeting it, deciding among those options, and then monitoring the outcome to make sure it was actually handled. What matters for our purposes is that the demanding parts of this list are the first and the last. The deciding is quick. The anticipating and the monitoring are what wear on a person, precisely because they have no edges, run continuously in the background, and never switch off.

More recent work has named the administrative slice of this labour specifically. A 2024 study published in the journal Social Sciences, examining the burden of administrative household labour, characterises it as work that is mainly cognitive and invisible and therefore difficult to quantify, distinguishing it from the physical chores it usually gets lumped in with, and links the resulting mental workload to stress, anxiety, and a diminished sense of well-being. The same body of research consistently finds this load to be unequally distributed within households, which means that for many people it is not only a cognitive cost but a quietly unfair one. The point of invoking this literature is not to import its concerns wholesale but to establish a single foundational claim on solid ground: the work of keeping track is real cognitive labour, the expensive parts of it are anticipation and monitoring, and a tool that wants to reduce the burden must therefore take over the watching rather than merely store the data.

## 3. The evidence base

To move from a frame to a case, the burden has to be shown rather than asserted, and the public record supplies enough to do that across the principal categories Kept addresses. The figures below come from named surveys and market studies, and the reader should hold in mind throughout that these are third-party numbers with their own methodologies, a caveat made fully explicit in the methodology section.

### 3.1 Subscriptions, the metered recurring failure

Subscriptions are the best-documented corner of the problem because the money involved is recurring and therefore easy to measure, and the consistent finding across several years of consumer research is that people lose meaningful sums to subscriptions they have forgotten or stopped using. Surveys of United States consumers, including work by C+R Research, have repeatedly put the average monthly waste on unused subscriptions in the region of thirty-odd dollars, which annualises to roughly three hundred and ninety to four hundred dollars per person. The same research has found that a large share of people, on the order of two in five, have at some point kept paying for a subscription they had forgotten about, and that close to half have been charged after failing to cancel a free trial before it converted. The drift is structural rather than occasional: consumer-pulse work by West Monroe has found households adding new subscriptions faster than they shed old ones, and survey work by Bankrate has found a majority keeping subscriptions on a just-in-case basis rather than from active use.

The most telling finding, though, is not the waste itself but the blindness that precedes it. A recurring theme across this literature is that people underestimate how much they spend on subscriptions and often cannot say how many they have, which is the signature of a tracking failure rather than a spending choice. People are not deciding to waste the money. They have lost sight of the obligations, the charges continue on their own, and the cost is discovered, if it is discovered at all, long after the fact.

### 3.2 Warranties, receipts, and proof of purchase, the value-at-stake failure

If subscriptions show money leaking out, warranties show value going unclaimed, and the scale of the value at stake is large. Market studies of the extended warranty and product-protection sector, produced by firms including Grand View Research, IMARC, and Allied Market Research, place the global market somewhere in the range of roughly one hundred and thirty to one hundred and ninety billion dollars as of 2024 to 2025, with United States estimates commonly in the high forties to low fifties of billions, the spread reflecting genuine disagreement between firms about scope and definition. The precise number matters less than the order of magnitude, which is that an enormous amount of consumer money is committed to coverage whose value can only be realised if the holder can later produce evidence of purchase and remember that the coverage exists.

That is exactly where the system breaks. Across retailer and manufacturer warranty policies, a claim generally requires proof of purchase, most often a receipt, and the burden of retaining that proof for the full life of the coverage falls entirely on the consumer. The friction this produces is widely acknowledged across consumer-help literature and retailer support documentation, which is full of guidance for the common situation of a person trying to claim on a valid warranty without the receipt they have lost. The deeper irony, frequently noted, is that in an era when a phone can track sleep and unlock a front door, the proof that unlocks a warranty still typically depends on a fragile paper artifact and on the owner happening to remember, months or years later, both that the item is covered and where the evidence is kept. The failure here is not the warranty. It is the absence of a durable, retrievable record tied to the thing it protects.

### 3.3 Documents, identity, and expiry, the deadline failure

The third category is the one with the least clean quantitative literature and arguably the highest stakes per incident, namely the documents and dated obligations whose lapse carries real consequence: passports and identity papers that expire, licences and permits that must be renewed, and the more mundane but genuinely hazardous case of food and medicine that has passed its date. These share a structure that makes them especially prone to failure. Each is governed by a date that is fixed and knowable in advance but that nothing actively watches, and the cost of missing the date is concentrated and badly timed, a passport discovered to be expired in the week before a trip being the canonical example. This is the part of the domain where Daminger's monitoring act is most clearly the expensive one, because the deciding is trivial, a renewal is obvious once it is in view, but the obligation to keep the date in mind across months or years is a continuous low-grade tax on attention that the human mind is poorly suited to pay reliably.

### 3.4 The common thread

Read together, these three categories are not three problems but one problem wearing three costumes. In each case the underlying record exists, the consequence of losing track is real, the relevant moment is knowable in advance, and yet the obligation routinely lapses, not because the person is careless but because nothing is watching on their behalf. The money leaks, the value goes unclaimed, the deadline passes. The next section asks why this keeps happening even to organised and well-intentioned people.

## 4. Why life admin fails: a structural analysis

The temptation is to explain these failures as personal shortcomings, a matter of insufficient discipline that the right amount of effort would fix. The evidence argues against that reading, because the failures are too consistent across too many people to be individual, and because the people affected are frequently organised in every other visible part of their lives. The better explanation is structural, and it has four parts that compound one another.

The first is that the records governing a person's obligations are scattered across many disconnected systems of record. The receipt is in an email, or a shopping bag, or a drawer. The subscription is on a card statement, mixed in with everything else and labelled cryptically. The passport is in one place and the awareness of its expiry date is nowhere. The warranty terms are in a manual that was discarded with the box. No single place holds the full picture, which means that answering even a simple question, such as what do I currently pay for or what of mine expires this year, requires assembling fragments from sources that were never designed to be assembled.

The second is that there is no trusted single home for this information, and the absence is not an accident but a consequence of the data's sensitivity, a point developed in the next section. Because the natural candidates for a unified home all involve handing a comprehensive picture of one's possessions, finances, and identity to a third party, many people decline the unification and accept the scatter instead, choosing privacy at the cost of organisation.

The third is that the consequences of losing track are delayed and asymmetric. A subscription you forget keeps charging quietly for months. A receipt you fail to keep costs you nothing until the day the appliance breaks. A date you stop watching is harmless until the moment it is not. Because the feedback is so far removed in time from the lapse that caused it, the ordinary learning loop that would teach a person to build a better system never closes, and the cost is absorbed as bad luck rather than diagnosed as a missing capability.

The fourth, and the one that ties the others together, is that nothing surfaces an obligation before it matters. The systems people use are passive stores at best. A note holds what you put in it but never speaks. A folder of receipts answers a question only if you already know to ask it. What the domain demands, and what no common tool provides, is the monitoring act from the cognitive-labour frame, performed by something other than the person: a system that watches the dates and the renewals and brings the right item forward at the right moment, unprompted.

## 5. The privacy dimension and the trust constraint

The structural analysis above identified the absence of a trusted single home as central, and that absence deserves its own treatment because it is the constraint that has shaped, and arguably crippled, every previous attempt to solve the unification problem. The information involved in life administration is unusually sensitive in aggregate. It is a map of what a person owns, what they pay for, who they bank with, what medication they take, and which identity documents they hold, and a single service that aggregated all of it would constitute one of the most revealing personal datasets a person could assemble anywhere.

Consumers are aware of this in a general way and increasingly act on it. Cisco's 2024 Consumer Privacy Survey, drawing on responses from more than two thousand six hundred people across a dozen countries, found that three quarters of consumers say they will not buy from a company they do not trust with their data, and that around half of the more privacy-conscious among them have already switched providers over data-handling practices. Global work summarised by the International Association of Privacy Professionals has found roughly two thirds of consumers somewhat or very concerned about their online privacy. The same Cisco research also captured the gap between concern and behaviour that defines the present moment: a large majority say they are worried about personal information entered into generative AI tools becoming exposed, yet a significant minority enter such information anyway, because the utility is in front of them and the risk is abstract.

That gap is the heart of the matter for a life-administration tool. The convenience of unification pulls people toward handing their data to a cloud service, while their stated values and their growing willingness to switch pull them away from it, and most existing products resolve the tension in the direction of convenience, asking the user to trust a remote server with the most sensitive inventory of their life. The thesis of this report is that the tension does not have to be resolved by sacrificing one side, because a design now exists that offers the unification without the disclosure, and it is to that design that the report now turns.

## 6. The landscape of existing approaches and why they fall short

Before proposing a design it is worth being precise about why the tools people already have do not suffice, because each of them solves a part of the problem and the pattern of their partial failures is itself instructive.

General-purpose notes and spreadsheets are the most common fallback, and they fail on the monitoring act. They will hold whatever a person is disciplined enough to enter, but they are inert, they never surface anything on their own, and they place the entire ongoing burden of anticipation and review back on the user, which is the very burden the domain makes unbearable.

Reminder and calendar applications solve a narrow slice, the dated deadline, but they require the person to have already done the hard part, which is knowing the date, deciding it matters, and entering it, and they treat each reminder as an isolated event with no connection to the thing it concerns, so they never become a record of what one owns or owes.

Bank and card applications, and the subscription-detection features some of them now offer, see the recurring charges and can surface forgotten subscriptions, which is genuinely useful, but their visibility stops at the financial transaction. They know nothing of warranties, documents, or expiry dates, they cannot help with anything that did not pass through a payment, and they necessarily hold the data on the institution's servers.

Dedicated subscription trackers and digital-warranty services address specific categories directly, but they tend to fail on two of this report's themes at once. Many are themselves sold by subscription, which produces the particular absurdity of paying a recurring fee to a service whose purpose is to save you from recurring fees, and many operate as cloud services that ask the user to upload exactly the sensitive financial and purchase data the privacy section warned about. They are single-purpose, so they re-fragment the problem rather than unifying it, and they sit on the wrong side of the trust constraint.

Cloud document storage solves durability and retrieval for documents but adds no intelligence, performs no monitoring, imposes no structure relevant to obligations, and again centralises sensitive material remotely. The closest useful analogue to what the domain actually needs is the password manager, which earned trust precisely by combining a single secure home with a strong privacy posture and proactive surfacing of problems, and the lesson worth taking from it is that people will adopt a consolidated home for sensitive information when, and only when, the privacy model is credible enough to make the consolidation feel safe.

## 7. The design thesis: a private, on-device system of record

The preceding analysis does not merely describe a problem, it constrains the solution, and when the constraints are taken seriously they point with unusual clarity to a particular design. Each of its principles is a direct response to a failure identified above rather than a feature chosen for its own sake.

It must be a single system of record, because the first structural failure is scatter, and the value of unification, the ability to answer what do I pay for and what of mine expires from one place, is precisely what no scattered set of tools can provide.

It must live and process on the person's own device, because the absence of a trusted home is the constraint that defeated unification before, and the privacy evidence shows that people will consolidate sensitive information only when the trust model is credible. Processing the data locally, so that the sensitive map of a person's life never leaves the hardware they hold, resolves the convenience-versus-privacy tension that every cloud-based predecessor was forced to compromise, and it converts privacy from a policy promise into an architectural fact.

It should be paid for once rather than by subscription, partly to avoid the absurdity of metering a tool whose job is to tame recurring costs, and partly because a one-time purchase aligns the maker's incentives with the user's in a way a subscription does not, removing any motive to manufacture engagement or to hold the user's own records hostage to a continuing fee.

It should organise items under the real-world entities they belong to, a car, a home, a person, a trip, rather than as a flat undifferentiated list, because this is how the obligations actually cluster in a life and because the entity is the unit at which a person reasons about their administration. The warranty, the insurance renewal, the service history, and the registration date are not four unrelated items, they are four facts about the same car, and a system that groups them as such matches the structure of the problem rather than fighting it.

Finally, and most importantly, it should include an assistant that performs the monitoring act and prepares the resulting action, but that never acts on its own. This is the principle that follows most directly from the cognitive-labour frame, which identified anticipation and monitoring as the expensive acts, and from the trust constraint, which forbids autonomous action over sensitive material. An assistant that watches the dates, detects the gaps, and assembles the next step, drafting the warranty-claim message, gathering the documents a renewal will need, flagging the subscription that has gone unused, and then presents that prepared action to the person for approval rather than sending it, takes over exactly the part of the labour that wears on people while keeping the human in final control of anything consequential. It offloads the watching without surrendering the deciding, which is the correct division of labour both cognitively and on grounds of trust.

## 8. Technical feasibility: why this is buildable now

A design is only worth proposing if it can actually be built, and the reason this particular design is timely rather than perennial is that the capabilities it depends on have only recently become available on consumer devices at the necessary quality. A private system of record is demanding precisely because it asks for cloud-grade intelligence without the cloud, and until recently that combination was not on offer.

It is now. Modern devices perform high-quality text recognition locally, so a receipt or a document can be read and its key facts extracted without the image ever being sent anywhere, which is what makes private capture possible at all. Apple's on-device intelligence has advanced to the point where a capable language model runs directly on the hardware, and the company's developer announcements at its 2026 developer conference extended this further, giving developers a local model with structured-output capabilities suited to exactly the kind of task this design requires, namely turning a messy document into a typed, validated draft action, all without data leaving the device or incurring any server cost. The same platform now lets an application expose its own content to the system's assistant and personal-context search through a local semantic index that operates on the device, which means a private application can answer natural-language questions about a person's own records without surrendering those records to a remote service. Synchronisation across a person's own devices can be handled through their personal cloud account rather than through a developer-operated server, so that the maker of the application never holds the data and the application can honestly declare that it collects none.

Taken together, these capabilities close the gap that previously forced a choice between intelligence and privacy. The watching, the reading, the drafting, and the answering can all now happen locally, which is what makes the private-system-of-record design not merely desirable in principle but constructible in practice at this particular moment, and what distinguishes a tool built on this thesis today from the cloud-bound predecessors that had no other option.

## 9. Open questions and what the product is built to test

A report that only marshalled evidence in favour of its own thesis would be advocacy rather than research, and intellectual honesty requires setting out plainly the questions this analysis leaves open, several of which are genuinely uncertain and all of which the product is designed to test rather than to assume.

The first and most important is whether people will trust an assistant that prepares administrative actions, even one that lives on their own device and never acts without approval. The design rests on the bet that local processing plus human approval is sufficient to earn that trust, but the strength of the convenience-over-privacy behaviour documented earlier cuts both ways, and it is an empirical question whether users will engage the assistant's prepared actions or quietly ignore them.

The second is whether the entity model genuinely reduces the felt burden or merely relocates it. Grouping items under a car or a home matches how the problem is structured analytically, but it is an open question whether ordinary users find that structure natural to set up and maintain, or whether the act of creating and populating entities is itself a friction that deters them.

The third concerns capture. The entire system is worthless if items do not get into it, and the right amount of capture friction is unknown in advance. Too much and the records are never entered, too little and the captured data is too thin to be useful, and where the workable point lies is something only real use will reveal.

The fourth is whether proactive surfacing actually changes behaviour and recovers value. The thesis predicts that a system performing the monitoring act will lead people to cancel subscriptions they would otherwise have kept paying for, claim warranties they would otherwise have lost, and meet deadlines they would otherwise have missed, but whether a surfaced prompt reliably converts into the desired action, rather than being dismissed like any other notification, is a behavioural question the product exists to answer.

These uncertainties are not weaknesses in the case so much as the specification of what the product must learn, and they are recorded here so that any later claims about the product's effect can be measured against hypotheses that were stated in advance rather than constructed after the fact.

## 10. Methodology and limitations

This report is a synthesis of secondary research combined with original structural and design reasoning. It does not present primary user research, and it should not be read as if it did. Its contribution is the framing, the structural analysis of why the failures persist, and the derivation of a design from those constraints, while its factual claims about the scale of the problem rest on third-party sources that carry the usual limitations of such material.

Several specific caveats apply. The survey figures on subscriptions and on privacy attitudes come from consumer surveys conducted by named organisations, each with its own sample, its own definitions, and in some cases a commercial interest in the topic, and survey self-reports of behaviour and spending are known to diverge from measured reality. The market-size figures for extended warranties vary considerably across the firms that produce them, which is why this report gives a range rather than a single number and treats the order of magnitude rather than any precise figure as the meaningful fact. Much of the available consumer data is weighted toward the United States and the United Kingdom, so its applicability to other markets is an assumption rather than a demonstrated fact. The sociological literature on cognitive labour is robust as a frame but was developed to study the division of household work and the distribution of its burden, not to evaluate software, so it is borrowed here for its conceptual structure rather than treated as direct evidence for any product claim. And the technical-feasibility section describes capabilities as announced and documented by the platform vendor as of mid-2026, some of which were still reaching general availability at the time of writing and should be verified against current platform documentation before any are relied upon in a shipped product.

Stated plainly, what is well established is that personal life administration is a real cognitive burden, that people lose money and value and miss deadlines in consistent and measurable ways, that the data involved is sensitive enough to make people wary of centralised solutions, and that the local capabilities required for a private alternative now exist. What remains hypothesis, and what the product is built to test, is whether the specific design proposed here will be adopted and will change behaviour in the ways the analysis predicts.

---

## References

C+R Research, 2024 Subscription Survey, as reported in consumer-finance coverage and aggregations. The aggregator page the figure was first taken from has since been withdrawn; the corroborating sources below carry the same finding.

Self Financial, Cost of Unused Paid Subscriptions, https://www.self.inc/info/cost-of-unused-paid-subscriptions/

Apple World Today, summary of Self Financial subscription survey, https://appleworld.today/2024/08/study-americans-waste-32-84-a-month-on-unused-paid-subscriptions/

YouGov Surveys: Serviced, Subscription graveyard, https://yougov.com/articles/50030-subscription-graveyard-how-many-unused-subscriptions-are-consumers-currently-paying-for

Allison Daminger, work on the cognitive dimension of household labour (2019), as discussed in subsequent scholarship and coverage cited below.

The Burden of Administrative Household Labour: Measuring Temporal Workload, Mental Workload, and Satisfaction, Social Sciences, 2024, https://www.mdpi.com/2076-0760/13/8/404

Beyond Time: the invisible burden of mental load (working paper), https://arxiv.org/pdf/2505.11426

The gendered division of cognitive household labour, mental load, and family-work conflict in European countries, https://www.tandfonline.com/doi/full/10.1080/14616696.2023.2271963

Grand View Research, Extended Warranty Market Size, Share, Industry Report, https://www.grandviewresearch.com/industry-analysis/extended-warranty-market-report

IMARC Group, Extended Warranty Market, https://www.imarcgroup.com/extended-warranty-market

Allied Market Research, Extended Warranty Market, https://www.alliedmarketresearch.com/extended-warranty-market

Cisco, 2024 Consumer Privacy Survey, https://www.cisco.com/c/en/us/about/trust-center/consumer-privacy-survey.html

International Association of Privacy Professionals, Privacy and Consumer Trust summary, https://iapp.org/resources/article/privacy-and-consumer-trust-summary

Thales, 2024 Consumer Digital Trust Index, https://cpl.thalesgroup.com/2024/digital-trust-index

Note on technical-feasibility sources: the capabilities described in section eight are drawn from the analysis of Apple's WWDC 2026 announcements regarding on-device foundation models, the App Intents framework, and the on-device semantic index, and should be verified against current Apple developer documentation before being relied upon.
