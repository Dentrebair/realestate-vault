// Labelled messages for the router. Each has one intended meaning. A property is on screen in every case:
// "High-Rise 2BHK Apartment near Tech Parks" (Navalur, OMR, ₹62 L) and "Compact 1BHK Starter Flat" (East Tambaram, ₹28 L).
// When a real customer message is misrouted, add it here.
export const shown = [
  { id: 'p04', title: 'High-Rise 2BHK Apartment near Tech Parks', location: 'Navalur, OMR, Chennai', priceDisplay: '₹62 L' },
  { id: 'p16', title: 'Compact 1BHK Starter Flat', location: 'East Tambaram, Chennai', priceDisplay: '₹28 L' }
];

export const cases = [
  // photos
  ['do you have images', 'photos'], ['show me pictures of the second one', 'photos'], ['any pics?', 'photos'], ['photos irukka', 'photos'],
  ['can I see how it looks inside', 'photos'], ['send me the gallery', 'photos'],
  // rental
  ['2BHK for rent in Velachery', 'rental'], ['I want to rent a flat', 'rental'], ['looking for a house on lease', 'rental'], ['PG near Tidel Park', 'rental'],
  ['need an office to rent in OMR', 'rental'], ['monthly rent ku veedu venum', 'rental'], ['can I take this on lease for 2 years', 'rental'],
  // negotiation
  ['can i get for 54L', 'negotiation'], ['will you take 55 lakh', 'negotiation'], ['is the price negotiable?', 'negotiation'], ['can the price come down a bit', 'negotiation'],
  ['the other builder is giving at 58L, can you match', 'negotiation'], ['54 lakh ku mudiyuma', 'negotiation'], ['any offers running on this?', 'negotiation'], ['what is your last price', 'negotiation'],
  // price question
  ['price of High-Rise 2BHK near omr?', 'price_question'], ['how much is the first one', 'price_question'], ['what is the cost of the second one', 'price_question'],
  ['vilai enna', 'price_question'], ['second one evlo price', 'price_question'], ['what is the asking price', 'price_question'], ['how much does the Tambaram flat cost', 'price_question'],
  // hours
  ['what are your office hours', 'hours'], ['when are you open', 'hours'], ['what time do you open', 'hours'], ['timings enna', 'hours'],
  ['are you open on Sunday', 'hours'], ['till what time can I call or visit your office', 'hours'],
  // human
  ['am I talking to a real person', 'human'], ['are you a bot', 'human'], ['is this a human', 'human'], ['nee bot ah illa manushana', 'human'], ['who am I chatting with, a machine?', 'human'],
  // other city
  ['do you have flats in Bangalore', 'other_city'], ['any properties in Mumbai', 'other_city'], ['Hyderabad la irukka', 'other_city'], ['I want to buy in Coimbatore', 'other_city'],
  ['do you sell in Pune', 'other_city'], ['what about Kochi', 'other_city'],
  // count
  ['how many properties do you have', 'count'], ['how many listings are there', 'count'], ['what is your total inventory', 'count'], ['how many options do you have in all', 'count'],
  ['evlo properties irukku', 'count'],
  // availability
  ['is the first one still available', 'availability'], ['has the Navalur flat been sold', 'availability'], ['is it still on sale', 'availability'], ['second one available ah', 'availability'],
  ['is this one taken already', 'availability'], ['can I still buy the Tambaram flat', 'availability'],
  // visit time
  ['can I visit tomorrow at 5pm', 'visit_time'], ['I want to see it on Saturday', 'visit_time'], ['can we come this weekend', 'visit_time'], ["I'd like to tour it today",'visit_time'],
  ['naalaiku 4 mani ku paakalama', 'visit_time'], ['is Sunday morning ok for a visit', 'visit_time'],
  // compare
  ['which is better', 'compare'], ['compare the two', 'compare'], ['which one would you recommend', 'compare'], ['which should I pick', 'compare'], ['rendu la edhu nalladhu', 'compare'],
  // topics
  ['is there parking', 'topic:parking'], ['how many car park slots', 'topic:parking'], ['any lift in the building', 'topic:lift'], ['which floor is it on', 'topic:floor'],
  ['which direction does it face', 'topic:facing'], ["what's the carpet area", 'topic:size'], ['when can I move in', 'topic:possession'], ['is it RERA approved', 'topic:approvals'],
  ['is the title clear', 'topic:approvals'], ['what is the monthly maintenance', 'topic:maintenance'], ['is it furnished', 'topic:furnishing'], ['how old is the building', 'topic:age'],
  ['is there a gym or pool', 'topic:amenities'], ['what is the view from the balcony', 'topic:view'], ['how far is the metro', 'topic:distances'], ['what is the rental yield', 'topic:rent_yield'],
  ['is there a current tenant', 'topic:rent_yield'], ['who is the builder', 'topic:builder'], ['are pets allowed', 'topic:pets'], ['what is the exact address', 'topic:address'],
  ['can you help with a home loan', 'topic:loan'], ['how much is stamp duty', 'topic:loan'], ['can you send the brochure', 'topic:documents'], ['call me back please', 'topic:contact'],
  ['is a metro coming near here', 'topic:transport_plans'], ['is it a good investment', 'topic:investment'], ['what is the average price per sq ft in OMR', 'topic:market'],
  ['is the area prone to flooding', 'topic:safety_traffic'], ['any good schools nearby', 'topic:nearby_places'], ['tell me about OMR as a place to live', 'topic:area_guide'],
  ['parking vasathi irukka', 'topic:parking'],
  // search
  ['show me 2BHK in OMR under 80 lakh', 'search'], ['I want a villa in ECR', 'search'], ['3BHK in Anna Nagar budget 2 crore', 'search'], ['looking for a plot near Tambaram', 'search'],
  ['anything cheaper', 'search'], ['OMR la 2BHK venum', 'search'], ['show me something with a sea view', 'search'], ['what do you have in Velachery', 'search'], ['I need a shop in T Nagar', 'search'],
  // other
  ['hi', 'other'], ['thanks', 'other'], ['ok', 'other'], ['I will think about it', 'other'], ['good morning', 'other'], ['my name is Ravi', 'other'], ['okay cool', 'other'], ['let me talk to my wife first', 'other']
];
