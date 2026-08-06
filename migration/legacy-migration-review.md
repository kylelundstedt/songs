# Phase 0 legacy migration review

This report intentionally lists metadata and paths only; it does not reproduce lead-sheet bodies or lyrics.

## Source and result

- Legacy Git commit: `6cfbda8e4d8a99e8fbe2762d7e4a5add89b5f659` (clean worktree)
- Lead sheets copied byte-for-byte: **284**
- Set-list entries converted in order: **32**
- Generated set list: `sets/2021-02-20-murphys.md`
- Source event manifest SHA-256: `6030cbe9ca25a9233591cdb93c81190937e92b3a66a5c630302f275a12b82c77`

## Validation

- Source/destination song SHA-256 equality: **284/284**
- Master manifest coverage: **284/284**, no missing, extra, or duplicate rows
- Ordered event entries resolve: **32/32**
- Generated relative links resolve: **32/32**
- Overall validation: **PASS**

## Human review queues

- Unsectioned sheets (no legacy H3 section headings): **167**
- Missing explicit performance keys retained as unknown: **284**
- Title/filename mapping anomalies: **5**

### Title/filename anomalies

| Legacy path | H1 title | Proposed canonical ID |
| --- | --- | --- |
| `lead-sheet/Have-A-Drink-On-Me.md` | Have A Drink On | `have-a-drink-on` |
| `lead-sheet/Redemption-Song-Live.md` | Redemption Song | `redemption-song` |
| `lead-sheet/Rock-and-Roll-Ain-t-Noise-Pollution.md` | Rock n Roll Ain t Noise Pollution | `rock-n-roll-ain-t-noise-pollution` |
| `lead-sheet/Superstition-Single-Version.md` | Superstition | `superstition` |
| `lead-sheet/Thank-You-Falettinme-Be-Mice-Elf-Agin.md` | Thank You Falettinme | `thank-you-falettinme` |

## Complete title mapping

The target filename is deliberately preserved for Phase 0. `proposed_canonical_id` is review metadata only; it does not rename or rewrite a lead sheet.

| Legacy file | H1 title | Preserved target | Proposed canonical ID | H3 sections |
| --- | --- | --- | --- | ---: |
| `1979.md` | 1979 | `songs/1979.md` | `1979` | 11 |
| `6th-Avenue-Heartache.md` | 6th Avenue Heartache | `songs/6th-Avenue-Heartache.md` | `6th-avenue-heartache` | 0 |
| `8675309.md` | 8675309 | `songs/8675309.md` | `8675309` | 0 |
| `Across-The-Universe.md` | Across The Universe | `songs/Across-The-Universe.md` | `across-the-universe` | 10 |
| `All-About-That-Bass.md` | All About That Bass | `songs/All-About-That-Bass.md` | `all-about-that-bass` | 11 |
| `All-Summer-Long.md` | All Summer Long | `songs/All-Summer-Long.md` | `all-summer-long` | 17 |
| `All-These-Things-That-I-ve-Done.md` | All These Things That I ve Done | `songs/All-These-Things-That-I-ve-Done.md` | `all-these-things-that-i-ve-done` | 0 |
| `Allison.md` | Allison | `songs/Allison.md` | `allison` | 0 |
| `Always-On-The-Run.md` | Always On The Run | `songs/Always-On-The-Run.md` | `always-on-the-run` | 8 |
| `Amber.md` | Amber | `songs/Amber.md` | `amber` | 7 |
| `American-Idiot.md` | American Idiot | `songs/American-Idiot.md` | `american-idiot` | 0 |
| `Angel-From-Montgomery.md` | Angel from Montgomery | `songs/Angel-From-Montgomery.md` | `angel-from-montgomery` | 7 |
| `Animal.md` | Animal | `songs/Animal.md` | `animal` | 0 |
| `Any-Way-You-Want-It.md` | Any Way You Want It | `songs/Any-Way-You-Want-It.md` | `any-way-you-want-it` | 0 |
| `Are-You-Gonna-Be-My-Girl.md` | Are You Gonna Be My Girl | `songs/Are-You-Gonna-Be-My-Girl.md` | `are-you-gonna-be-my-girl` | 0 |
| `Are-You-Gonna-Go-My-Way.md` | Are You Gonna Go My Way | `songs/Are-You-Gonna-Go-My-Way.md` | `are-you-gonna-go-my-way` | 12 |
| `Baby-I-Love-You.md` | Baby I Love You | `songs/Baby-I-Love-You.md` | `baby-i-love-you` | 7 |
| `Back-In-Black.md` | Back In Black | `songs/Back-In-Black.md` | `back-in-black` | 0 |
| `Bad-Romance.md` | Bad Romance | `songs/Bad-Romance.md` | `bad-romance` | 13 |
| `Bad-Things.md` | Bad Things | `songs/Bad-Things.md` | `bad-things` | 0 |
| `Badfish.md` | Badfish | `songs/Badfish.md` | `badfish` | 10 |
| `Bang-a-Gong-Get-It-On.md` | Bang a Gong Get It On | `songs/Bang-a-Gong-Get-It-On.md` | `bang-a-gong-get-it-on` | 0 |
| `Beer-Drinkers-n-Hell-Raisers.md` | Beer Drinkers n Hell Raisers | `songs/Beer-Drinkers-n-Hell-Raisers.md` | `beer-drinkers-n-hell-raisers` | 0 |
| `Behind-Blue-Eyes.md` | Behind Blue Eyes | `songs/Behind-Blue-Eyes.md` | `behind-blue-eyes` | 0 |
| `Bent.md` | Bent | `songs/Bent.md` | `bent` | 0 |
| `Betterman.md` | Betterman | `songs/Betterman.md` | `betterman` | 0 |
| `Billie-Jean.md` | Billie Jean | `songs/Billie-Jean.md` | `billie-jean` | 15 |
| `Black-Hole-Sun.md` | Black Hole Sun | `songs/Black-Hole-Sun.md` | `black-hole-sun` | 12 |
| `Black.md` | Black | `songs/Black.md` | `black` | 7 |
| `Blister-In-The-Sun.md` | Blister In The Sun | `songs/Blister-In-The-Sun.md` | `blister-in-the-sun` | 0 |
| `Blue-Monday.md` | Blue Monday | `songs/Blue-Monday.md` | `blue-monday` | 0 |
| `Born-To-Run.md` | Born To Run | `songs/Born-To-Run.md` | `born-to-run` | 15 |
| `Boys-Don-t-Cry.md` | Boys Don t Cry | `songs/Boys-Don-t-Cry.md` | `boys-don-t-cry` | 0 |
| `Breakdown.md` | Breakdown | `songs/Breakdown.md` | `breakdown` | 7 |
| `Brick-House.md` | Brick House | `songs/Brick-House.md` | `brick-house` | 10 |
| `Brown-Eyed-Girl.md` | Brown Eyed Girl | `songs/Brown-Eyed-Girl.md` | `brown-eyed-girl` | 11 |
| `Budapest.md` | Budapest | `songs/Budapest.md` | `budapest` | 0 |
| `Californication.md` | Californication | `songs/Californication.md` | `californication` | 18 |
| `Can-t-Stop.md` | Can't Stop | `songs/Can-t-Stop.md` | `cant-stop` | 0 |
| `Can-t-You-See.md` | Can't You See | `songs/Can-t-You-See.md` | `cant-you-see` | 13 |
| `Chasing-Cars.md` | Chasing Cars | `songs/Chasing-Cars.md` | `chasing-cars` | 0 |
| `Cheap-Sunglasses.md` | Cheap Sunglasses | `songs/Cheap-Sunglasses.md` | `cheap-sunglasses` | 0 |
| `Closer-To-Fine.md` | Closer To Fine | `songs/Closer-To-Fine.md` | `closer-to-fine` | 0 |
| `Closing-Time.md` | Closing Time | `songs/Closing-Time.md` | `closing-time` | 0 |
| `Cold-Hard-Bitch.md` | Cold Hard Bitch | `songs/Cold-Hard-Bitch.md` | `cold-hard-bitch` | 0 |
| `Come-As-You-Are.md` | Come As You Are | `songs/Come-As-You-Are.md` | `come-as-you-are` | 0 |
| `Come-Together.md` | Come Together | `songs/Come-Together.md` | `come-together` | 0 |
| `Counting-Blue-Cars.md` | Counting Blue Cars | `songs/Counting-Blue-Cars.md` | `counting-blue-cars` | 0 |
| `Crash.md` | Crash | `songs/Crash.md` | `crash` | 0 |
| `Crawling-Back-To-You.md` | Crawling Back To You | `songs/Crawling-Back-To-You.md` | `crawling-back-to-you` | 15 |
| `Crazy-Bitch.md` | Crazy Bitch | `songs/Crazy-Bitch.md` | `crazy-bitch` | 0 |
| `Crazy.md` | Crazy | `songs/Crazy.md` | `crazy` | 8 |
| `Creep.md` | Creep | `songs/Creep.md` | `creep` | 8 |
| `Criminal.md` | Criminal | `songs/Criminal.md` | `criminal` | 0 |
| `Cumbersome.md` | Cumbersome | `songs/Cumbersome.md` | `cumbersome` | 9 |
| `Dancing-With-Myself.md` | Dancing With Myself | `songs/Dancing-With-Myself.md` | `dancing-with-myself` | 17 |
| `Dani-California.md` | Dani California | `songs/Dani-California.md` | `dani-california` | 0 |
| `Dark-Necessities.md` | Dark Necessities | `songs/Dark-Necessities.md` | `dark-necessities` | 0 |
| `Darling-Nikki.md` | Darling Nikki | `songs/Darling-Nikki.md` | `darling-nikki` | 0 |
| `Daughter.md` | Daughter | `songs/Daughter.md` | `daughter` | 0 |
| `Demons.md` | Demons | `songs/Demons.md` | `demons` | 0 |
| `Dock-Of-The-Bay.md` | Dock of the Bay | `songs/Dock-Of-The-Bay.md` | `dock-of-the-bay` | 9 |
| `Doin-Time.md` | Doin Time | `songs/Doin-Time.md` | `doin-time` | 8 |
| `Don-t-Go-Back-To-Rockville.md` | Don't Go Back To Rockville | `songs/Don-t-Go-Back-To-Rockville.md` | `dont-go-back-to-rockville` | 0 |
| `Drive.md` | Drive | `songs/Drive.md` | `drive` | 11 |
| `Elderly-Woman.md` | Elderly Woman | `songs/Elderly-Woman.md` | `elderly-woman` | 8 |
| `Enter-Sandman.md` | Enter Sandman | `songs/Enter-Sandman.md` | `enter-sandman` | 0 |
| `Even-Flow.md` | Even Flow | `songs/Even-Flow.md` | `even-flow` | 0 |
| `Everlong.md` | Everlong | `songs/Everlong.md` | `everlong` | 13 |
| `Every-Mother-s-Son.md` | Every Mother s Son | `songs/Every-Mother-s-Son.md` | `every-mother-s-son` | 10 |
| `Exs-And-Ohs.md` | Exs And Ohs | `songs/Exs-And-Ohs.md` | `exs-and-ohs` | 12 |
| `Face-In-The-Crowd.md` | Face In The Crowd | `songs/Face-In-The-Crowd.md` | `face-in-the-crowd` | 9 |
| `Faith.md` | Faith | `songs/Faith.md` | `faith` | 11 |
| `Fast-As-You.md` | Fast As You | `songs/Fast-As-You.md` | `fast-as-you` | 13 |
| `Feeling-Alright.md` | Feeling Alright | `songs/Feeling-Alright.md` | `feeling-alright` | 9 |
| `Feels-Sheriff.md` | Feels-Sheriff | `songs/Feels-Sheriff.md` | `feels-sheriff` | 14 |
| `Feels.md` | Feels | `songs/Feels.md` | `feels` | 8 |
| `Find-Yourself.md` | Find Yourself | `songs/Find-Yourself.md` | `find-yourself` | 13 |
| `Fire-On-The-Mountain.md` | Fire On The Mountain | `songs/Fire-On-The-Mountain.md` | `fire-on-the-mountain` | 0 |
| `Fly-Away.md` | Fly Away | `songs/Fly-Away.md` | `fly-away` | 0 |
| `Follow-Me.md` | Follow Me | `songs/Follow-Me.md` | `follow-me` | 0 |
| `Folsom-Prison-Blues.md` | Folsom Prison Blues | `songs/Folsom-Prison-Blues.md` | `folsom-prison-blues` | 8 |
| `Free-Fallin.md` | Free Fallin | `songs/Free-Fallin.md` | `free-fallin` | 0 |
| `Fuck-You.md` | Fuck You | `songs/Fuck-You.md` | `fuck-you` | 8 |
| `Get-Lucky.md` | Get Lucky | `songs/Get-Lucky.md` | `get-lucky` | 9 |
| `Gimme-All-Your-Lovin.md` | Gimme All Your Lovin | `songs/Gimme-All-Your-Lovin.md` | `gimme-all-your-lovin` | 0 |
| `Gimme-Shelter.md` | Gimme Shelter | `songs/Gimme-Shelter.md` | `gimme-shelter` | 0 |
| `Gimme-Three-Steps.md` | Gimme Three Steps | `songs/Gimme-Three-Steps.md` | `gimme-three-steps` | 10 |
| `Give-Me-One-Reason.md` | Give Me One Reason | `songs/Give-Me-One-Reason.md` | `give-me-one-reason` | 0 |
| `Givin-The-Dog-A-Bone.md` | Givin The Dog A Bone | `songs/Givin-The-Dog-A-Bone.md` | `givin-the-dog-a-bone` | 0 |
| `Glycerine.md` | Glycerine | `songs/Glycerine.md` | `glycerine` | 0 |
| `God-Of-Wine.md` | God of Wine | `songs/God-Of-Wine.md` | `god-of-wine` | 9 |
| `Going-Down-The-Road-Feeling-Bad.md` | Going Down The Road Feeling Bad | `songs/Going-Down-The-Road-Feeling-Bad.md` | `going-down-the-road-feeling-bad` | 0 |
| `Gone-Gone-Gone.md` | Gone Gone Gone | `songs/Gone-Gone-Gone.md` | `gone-gone-gone` | 0 |
| `Gone-Shootin.md` | Gone Shootin | `songs/Gone-Shootin.md` | `gone-shootin` | 0 |
| `Good-Times-Bad-Times.md` | Good Times Bad Times | `songs/Good-Times-Bad-Times.md` | `good-times-bad-times` | 0 |
| `Gravity.md` | Gravity | `songs/Gravity.md` | `gravity` | 0 |
| `Guitars-and-Cadillacs.md` | Guitars and Cadillacs | `songs/Guitars-and-Cadillacs.md` | `guitars-and-cadillacs` | 9 |
| `Hang-You-From-The-Heavens.md` | Hang You From The Heavens | `songs/Hang-You-From-The-Heavens.md` | `hang-you-from-the-heavens` | 0 |
| `Happy.md` | Happy | `songs/Happy.md` | `happy` | 12 |
| `Hard-To-Handle.md` | Hard To Handle | `songs/Hard-To-Handle.md` | `hard-to-handle` | 14 |
| `Hash-Pipe.md` | Hash Pipe | `songs/Hash-Pipe.md` | `hash-pipe` | 12 |
| `Have-A-Drink-On-Me.md` | Have A Drink On | `songs/Have-A-Drink-On-Me.md` | `have-a-drink-on` | 0 |
| `Heard-It-In-A-Love-Song.md` | Heard It In A Love Song | `songs/Heard-It-In-A-Love-Song.md` | `heard-it-in-a-love-song` | 15 |
| `Heart-Shaped-Box.md` | Heart Shaped Box | `songs/Heart-Shaped-Box.md` | `heart-shaped-box` | 0 |
| `Higher-Ground.md` | Higher Ground | `songs/Higher-Ground.md` | `higher-ground` | 0 |
| `Higher.md` | Higher | `songs/Higher.md` | `higher` | 0 |
| `Highway-To-Hell.md` | Highway To Hell | `songs/Highway-To-Hell.md` | `highway-to-hell` | 0 |
| `Hit-Me-With-Your-Best-Shot.md` | Hit Me With Your Best Shot | `songs/Hit-Me-With-Your-Best-Shot.md` | `hit-me-with-your-best-shot` | 0 |
| `Hold-My-Hand.md` | Hold My Hand | `songs/Hold-My-Hand.md` | `hold-my-hand` | 14 |
| `Home-Live.md` | Home Live | `songs/Home-Live.md` | `home-live` | 0 |
| `Home.md` | Home | `songs/Home.md` | `home` | 0 |
| `Hunger-Strike.md` | Hunger Strike | `songs/Hunger-Strike.md` | `hunger-strike` | 0 |
| `I-Don-t-Wanna-Be.md` | I Don t Wanna Be | `songs/I-Don-t-Wanna-Be.md` | `i-don-t-wanna-be` | 0 |
| `I-Kissed-a-Girl.md` | I Kissed a Girl | `songs/I-Kissed-a-Girl.md` | `i-kissed-a-girl` | 0 |
| `I-Shot-The-Sheriff.md` | I Shot The Sheriff | `songs/I-Shot-The-Sheriff.md` | `i-shot-the-sheriff` | 9 |
| `I-Want-You-Back.md` | I Want You Back | `songs/I-Want-You-Back.md` | `i-want-you-back` | 9 |
| `I-Want-You-To.md` | I Want You To | `songs/I-Want-You-To.md` | `i-want-you-to` | 10 |
| `I-Will-Survive.md` | I Will Survive | `songs/I-Will-Survive.md` | `i-will-survive` | 8 |
| `I-Wish.md` | I Wish | `songs/I-Wish.md` | `i-wish` | 14 |
| `I-m-Bad-I-m-Nationwide.md` | I'm Bad I'm Nationwide | `songs/I-m-Bad-I-m-Nationwide.md` | `im-bad-im-nationwide` | 0 |
| `In-The-Midnight-Hour.md` | In The Midnight Hour | `songs/In-The-Midnight-Hour.md` | `in-the-midnight-hour` | 4 |
| `In-Your-Eyes.md` | In Your Eyes | `songs/In-Your-Eyes.md` | `in-your-eyes` | 0 |
| `Inside-Out.md` | Inside Out | `songs/Inside-Out.md` | `inside-out` | 7 |
| `Interstate-Love-Song.md` | Interstate Love Song | `songs/Interstate-Love-Song.md` | `interstate-love-song` | 10 |
| `Jailbreak.md` | Jailbreak | `songs/Jailbreak.md` | `jailbreak` | 0 |
| `Jesus-Left-Chicago.md` | Jesus Left Chicago | `songs/Jesus-Left-Chicago.md` | `jesus-left-chicago` | 0 |
| `Jolene.md` | Jolene | `songs/Jolene.md` | `jolene` | 0 |
| `Juice-Dance.md` | Juice-Dance | `songs/Juice-Dance.md` | `juice-dance` | 10 |
| `Juice.md` | Juice | `songs/Juice.md` | `juice` | 9 |
| `Juicebox.md` | Juicebox | `songs/Juicebox.md` | `juicebox` | 0 |
| `Jump-Jive-Wail.md` | Jump Jive Wail | `songs/Jump-Jive-Wail.md` | `jump-jive-wail` | 13 |
| `Jump.md` | Jump | `songs/Jump.md` | `jump` | 10 |
| `Just-A-Girl.md` | Just A Girl | `songs/Just-A-Girl.md` | `just-a-girl` | 0 |
| `Just-Got-Paid.md` | Just Got Paid | `songs/Just-Got-Paid.md` | `just-got-paid` | 0 |
| `Just-Like-Heaven.md` | Just Like Heaven | `songs/Just-Like-Heaven.md` | `just-like-heaven` | 0 |
| `Just-What-I-Needed.md` | Just What I Needed | `songs/Just-What-I-Needed.md` | `just-what-i-needed` | 0 |
| `Killing-In-The-Name.md` | Killing In The Name | `songs/Killing-In-The-Name.md` | `killing-in-the-name` | 0 |
| `Kiss.md` | Kiss | `songs/Kiss.md` | `kiss` | 11 |
| `Kryptonite.md` | Kryptonite | `songs/Kryptonite.md` | `kryptonite` | 14 |
| `La-Grange.md` | La Grange | `songs/La-Grange.md` | `la-grange` | 0 |
| `Last-Nite.md` | Last Nite | `songs/Last-Nite.md` | `last-nite` | 0 |
| `Let-Me-Put-My-Love-Into-You.md` | Let Me Put My Love Into You | `songs/Let-Me-Put-My-Love-Into-You.md` | `let-me-put-my-love-into-you` | 0 |
| `Let-s-Get-It-On.md` | Let's Get It On | `songs/Let-s-Get-It-On.md` | `lets-get-it-on` | 9 |
| `Let-s-Go-Crazy.md` | Let's Go Crazy | `songs/Let-s-Go-Crazy.md` | `lets-go-crazy` | 0 |
| `Lets-Dance.md` | Lets Dance | `songs/Lets-Dance.md` | `lets-dance` | 9 |
| `Life-During-Wartime.md` | Life During Wartime | `songs/Life-During-Wartime.md` | `life-during-wartime` | 0 |
| `Lightning-Crashes.md` | Lightning Crashes | `songs/Lightning-Crashes.md` | `lightning-crashes` | 0 |
| `Like-A-Stone.md` | Like A Stone | `songs/Like-A-Stone.md` | `like-a-stone` | 0 |
| `Little-Less-Conversation.md` | Little Less Conversation | `songs/Little-Less-Conversation.md` | `little-less-conversation` | 0 |
| `Little-Lover.md` | Little Lover | `songs/Little-Lover.md` | `little-lover` | 0 |
| `Little-Sister.md` | Little Sister | `songs/Little-Sister.md` | `little-sister` | 0 |
| `Livin-After-Midnight.md` | Livin After Midnight | `songs/Livin-After-Midnight.md` | `livin-after-midnight` | 0 |
| `Locked-Out-Of-Heaven.md` | Locked Out Of Heaven | `songs/Locked-Out-Of-Heaven.md` | `locked-out-of-heaven` | 10 |
| `Lonely-Is-the-Night.md` | Lonely Is the Night | `songs/Lonely-Is-the-Night.md` | `lonely-is-the-night` | 0 |
| `Long-Train-Runnin.md` | Long Train Runnin | `songs/Long-Train-Runnin.md` | `long-train-runnin` | 0 |
| `Love-Rollercoaster.md` | Love Rollercoaster | `songs/Love-Rollercoaster.md` | `love-rollercoaster` | 0 |
| `Love-Shack.md` | Love Shack | `songs/Love-Shack.md` | `love-shack` | 13 |
| `Love-Train.md` | Love Train | `songs/Love-Train.md` | `love-train` | 0 |
| `Lovesong.md` | Lovesong | `songs/Lovesong.md` | `lovesong` | 0 |
| `Low.md` | Low | `songs/Low.md` | `low` | 0 |
| `Major-Tom.md` | Major Tom | `songs/Major-Tom.md` | `major-tom` | 0 |
| `Man-In-The-Box.md` | Man In The Box | `songs/Man-In-The-Box.md` | `man-in-the-box` | 0 |
| `Margaritaville.md` | Margaritaville | `songs/Margaritaville.md` | `margaritaville` | 9 |
| `Mary-Had-A-Little-Lamb.md` | Mary Had A Little Lamb | `songs/Mary-Had-A-Little-Lamb.md` | `mary-had-a-little-lamb` | 6 |
| `Mary-Jane-s-Last-Dance.md` | Mary Jane's Last Dance | `songs/Mary-Jane-s-Last-Dance.md` | `mary-janes-last-dance` | 0 |
| `Melissa.md` | Melissa | `songs/Melissa.md` | `melissa` | 0 |
| `Melt-With-You.md` | Melt With You | `songs/Melt-With-You.md` | `melt-with-you` | 0 |
| `Mercy.md` | Mercy | `songs/Mercy.md` | `mercy` | 10 |
| `Miss-You.md` | Miss You | `songs/Miss-You.md` | `miss-you` | 10 |
| `Moves-Like-Jagger.md` | Moves Like Jagger | `songs/Moves-Like-Jagger.md` | `moves-like-jagger` | 0 |
| `Mustang-Sally.md` | Mustang Sally | `songs/Mustang-Sally.md` | `mustang-sally` | 8 |
| `My-Hero.md` | My Hero | `songs/My-Hero.md` | `my-hero` | 0 |
| `My-Own-Worst-Enemy.md` | My Own Worst Enemy | `songs/My-Own-Worst-Enemy.md` | `my-own-worst-enemy` | 0 |
| `Mysterious-Ways.md` | Mysterious Ways | `songs/Mysterious-Ways.md` | `mysterious-ways` | 0 |
| `Never-Let-You-Go.md` | Never Let You Go | `songs/Never-Let-You-Go.md` | `never-let-you-go` | 0 |
| `New-Year-s-Day.md` | New Year's Day | `songs/New-Year-s-Day.md` | `new-years-day` | 0 |
| `No-One-Knows.md` | No One Knows | `songs/No-One-Knows.md` | `no-one-knows` | 0 |
| `No-Rain.md` | No Rain | `songs/No-Rain.md` | `no-rain` | 0 |
| `No-Woman-No-Cry.md` | No, Woman, No Cry | `songs/No-Woman-No-Cry.md` | `no-woman-no-cry` | 8 |
| `Nothing-Compares-2-U.md` | Nothing Compares 2 U | `songs/Nothing-Compares-2-U.md` | `nothing-compares-2-u` | 8 |
| `Numb.md` | Numb | `songs/Numb.md` | `numb` | 0 |
| `One.md` | One | `songs/One.md` | `one` | 0 |
| `Outshined.md` | Outshined | `songs/Outshined.md` | `outshined` | 0 |
| `Outside.md` | Outside | `songs/Outside.md` | `outside` | 0 |
| `Overkill.md` | Overkill | `songs/Overkill.md` | `overkill` | 0 |
| `Panama.md` | Panama | `songs/Panama.md` | `panama` | 0 |
| `Paradise-City.md` | Paradise City | `songs/Paradise-City.md` | `paradise-city` | 0 |
| `Paralyzer.md` | Paralyzer | `songs/Paralyzer.md` | `paralyzer` | 0 |
| `Patience.md` | Patience | `songs/Patience.md` | `patience` | 8 |
| `Peaceful-Easy-Feelin.md` | Peaceful Easy Feelin | `songs/Peaceful-Easy-Feelin.md` | `peaceful-easy-feelin` | 8 |
| `Play-That-Funky-Music.md` | Play That Funky Music | `songs/Play-That-Funky-Music.md` | `play-that-funky-music` | 12 |
| `Plush.md` | Plush | `songs/Plush.md` | `plush` | 12 |
| `Pompeii.md` | Pompeii | `songs/Pompeii.md` | `pompeii` | 0 |
| `Possum-Kingdom.md` | Possum Kingdom | `songs/Possum-Kingdom.md` | `possum-kingdom` | 0 |
| `Pride.md` | Pride | `songs/Pride.md` | `pride` | 0 |
| `Psycho-Killer.md` | Psycho Killer | `songs/Psycho-Killer.md` | `psycho-killer` | 0 |
| `Purple-Rain.md` | Purple Rain | `songs/Purple-Rain.md` | `purple-rain` | 8 |
| `Radioactive.md` | Radioactive | `songs/Radioactive.md` | `radioactive` | 0 |
| `Ramble-On.md` | Ramble On | `songs/Ramble-On.md` | `ramble-on` | 13 |
| `Rebel-Yell.md` | Rebel Yell | `songs/Rebel-Yell.md` | `rebel-yell` | 14 |
| `Redemption-Song-Live.md` | Redemption Song | `songs/Redemption-Song-Live.md` | `redemption-song` | 0 |
| `Ride-On.md` | Ride On | `songs/Ride-On.md` | `ride-on` | 0 |
| `Ring-Of-Fire.md` | Ring Of Fire | `songs/Ring-Of-Fire.md` | `ring-of-fire` | 0 |
| `Roadhouse-Blues.md` | Roadhouse Blues | `songs/Roadhouse-Blues.md` | `roadhouse-blues` | 0 |
| `Rock-and-Roll-Ain-t-Noise-Pollution.md` | Rock n Roll Ain t Noise Pollution | `songs/Rock-and-Roll-Ain-t-Noise-Pollution.md` | `rock-n-roll-ain-t-noise-pollution` | 0 |
| `Rock-n-Roll.md` | Rock n Roll | `songs/Rock-n-Roll.md` | `rock-n-roll` | 0 |
| `Rooster.md` | Rooster | `songs/Rooster.md` | `rooster` | 0 |
| `Runnin-With-The-Devil.md` | Runnin With The Devil | `songs/Runnin-With-The-Devil.md` | `runnin-with-the-devil` | 0 |
| `Santeria.md` | Santeria | `songs/Santeria.md` | `santeria` | 12 |
| `Say-It-Ain-t-So.md` | Say It Ain t So | `songs/Say-It-Ain-t-So.md` | `say-it-ain-t-so` | 10 |
| `Seven-Nation-Army.md` | Seven Nation Army | `songs/Seven-Nation-Army.md` | `seven-nation-army` | 15 |
| `Sex-And-Candy.md` | Sex and Candy | `songs/Sex-And-Candy.md` | `sex-and-candy` | 8 |
| `Sex-on-Fire.md` | Sex on Fire | `songs/Sex-on-Fire.md` | `sex-on-fire` | 0 |
| `Shake-Shake-Shake.md` | Shake Shake Shake | `songs/Shake-Shake-Shake.md` | `shake-shake-shake` | 9 |
| `Sharp-Dressed-Man.md` | Sharp Dressed Man | `songs/Sharp-Dressed-Man.md` | `sharp-dressed-man` | 0 |
| `She-Sells-Sanctuary.md` | She Sells Sanctuary | `songs/She-Sells-Sanctuary.md` | `she-sells-sanctuary` | 0 |
| `Shine.md` | Shine | `songs/Shine.md` | `shine` | 16 |
| `Shining-Star.md` | Shining Star | `songs/Shining-Star.md` | `shining-star` | 0 |
| `Short-Skirt.md` | Short Skirt | `songs/Short-Skirt.md` | `short-skirt` | 12 |
| `Simple-Man.md` | Simple Man | `songs/Simple-Man.md` | `simple-man` | 13 |
| `Sittin-On-The-Dock-Of-The-Bay.md` | Sittin On The Dock Of The Bay | `songs/Sittin-On-The-Dock-Of-The-Bay.md` | `sittin-on-the-dock-of-the-bay` | 9 |
| `Smells-Like-Teen-Spirit.md` | Smells Like Teen Spirit | `songs/Smells-Like-Teen-Spirit.md` | `smells-like-teen-spirit` | 0 |
| `So-Lonely.md` | So Lonely | `songs/So-Lonely.md` | `so-lonely` | 0 |
| `Some-Kind-Of-Wonderful.md` | Some Kind Of Wonderful | `songs/Some-Kind-Of-Wonderful.md` | `some-kind-of-wonderful` | 11 |
| `Song-2.md` | Song 2 | `songs/Song-2.md` | `song-2` | 0 |
| `Soulshine.md` | Soulshine | `songs/Soulshine.md` | `soulshine` | 10 |
| `Stayin-Alive.md` | Stayin Alive | `songs/Stayin-Alive.md` | `stayin-alive` | 10 |
| `Steady-As-She-Goes.md` | Steady As She Goes | `songs/Steady-As-She-Goes.md` | `steady-as-she-goes` | 0 |
| `Sullivan-Street.md` | Sullivan Street | `songs/Sullivan-Street.md` | `sullivan-street` | 0 |
| `Superstition-Single-Version.md` | Superstition | `songs/Superstition-Single-Version.md` | `superstition` | 13 |
| `Sweet-Emotion.md` | Sweet Emotion | `songs/Sweet-Emotion.md` | `sweet-emotion` | 0 |
| `Sweet-Home-Alabama.md` | Sweet Home Alabama | `songs/Sweet-Home-Alabama.md` | `sweet-home-alabama` | 14 |
| `TNT.md` | TNT | `songs/TNT.md` | `tnt` | 0 |
| `Take-Me-Out.md` | Take Me Out | `songs/Take-Me-Out.md` | `take-me-out` | 0 |
| `Tennessee-Whiskey.md` | Tennessee Whiskey | `songs/Tennessee-Whiskey.md` | `tennessee-whiskey` | 8 |
| `Thank-You-Falettinme-Be-Mice-Elf-Agin.md` | Thank You Falettinme | `songs/Thank-You-Falettinme-Be-Mice-Elf-Agin.md` | `thank-you-falettinme` | 14 |
| `Thank-You.md` | Thank You | `songs/Thank-You.md` | `thank-you` | 13 |
| `That-s-The-Way-I-Like-It.md` | That's The Way I Like It | `songs/That-s-The-Way-I-Like-It.md` | `thats-the-way-i-like-it` | 0 |
| `The-Big-Bang.md` | The Big Bang | `songs/The-Big-Bang.md` | `the-big-bang` | 9 |
| `The-Distance.md` | The Distance | `songs/The-Distance.md` | `the-distance` | 0 |
| `The-Middle.md` | The Middle | `songs/The-Middle.md` | `the-middle` | 10 |
| `The-Scientist.md` | The Scientist | `songs/The-Scientist.md` | `the-scientist` | 0 |
| `Thinking-Out-Loud.md` | Thinking Out Loud | `songs/Thinking-Out-Loud.md` | `thinking-out-loud` | 0 |
| `This-Is-How-You-Remind-Me.md` | This Is How You Remind Me | `songs/This-Is-How-You-Remind-Me.md` | `this-is-how-you-remind-me` | 0 |
| `Times-Like-These.md` | Times Like These | `songs/Times-Like-These.md` | `times-like-these` | 14 |
| `Tom-Sawyer.md` | Tom Sawyer | `songs/Tom-Sawyer.md` | `tom-sawyer` | 0 |
| `Touch-Too-Much.md` | Touch Too Much | `songs/Touch-Too-Much.md` | `touch-too-much` | 0 |
| `TroubleMaker.md` | TroubleMaker | `songs/TroubleMaker.md` | `troublemaker` | 0 |
| `Turn-The-Page.md` | Turn The Page | `songs/Turn-The-Page.md` | `turn-the-page` | 12 |
| `Tush.md` | Tush | `songs/Tush.md` | `tush` | 0 |
| `Under-The-Bridge.md` | Under The Bridge | `songs/Under-The-Bridge.md` | `under-the-bridge` | 10 |
| `Uptown-Funk.md` | Uptown Funk | `songs/Uptown-Funk.md` | `uptown-funk` | 12 |
| `Use-Me.md` | Use Me | `songs/Use-Me.md` | `use-me` | 11 |
| `Use-Somebody.md` | Use Somebody | `songs/Use-Somebody.md` | `use-somebody` | 0 |
| `Valerie.md` | Valerie | `songs/Valerie.md` | `valerie` | 11 |
| `Vasoline.md` | Vasoline | `songs/Vasoline.md` | `vasoline` | 0 |
| `Vertigo.md` | Vertigo | `songs/Vertigo.md` | `vertigo` | 0 |
| `Wagon-Wheel.md` | Wagon Wheel | `songs/Wagon-Wheel.md` | `wagon-wheel` | 0 |
| `Waitin-for-the-Bus.md` | Waitin for the Bus | `songs/Waitin-for-the-Bus.md` | `waitin-for-the-bus` | 0 |
| `Walk-This-Way.md` | Walk This Way | `songs/Walk-This-Way.md` | `walk-this-way` | 0 |
| `Walk.md` | Walk | `songs/Walk.md` | `walk` | 0 |
| `Wanted-Dead-Or-Alive.md` | Wanted Dead Or Alive | `songs/Wanted-Dead-Or-Alive.md` | `wanted-dead-or-alive` | 17 |
| `Welcome-To-The-Jungle.md` | Welcome To The Jungle | `songs/Welcome-To-The-Jungle.md` | `welcome-to-the-jungle` | 0 |
| `What-I-Got.md` | What I Got | `songs/What-I-Got.md` | `what-i-got` | 8 |
| `Wheels.md` | Wheels | `songs/Wheels.md` | `wheels` | 0 |
| `When-I-Come-Around.md` | When I Come Around | `songs/When-I-Come-Around.md` | `when-i-come-around` | 0 |
| `When-I-m-Gone.md` | When I'm Gone | `songs/When-I-m-Gone.md` | `when-im-gone` | 0 |
| `Whenever-You-Come-Around.md` | Whenever You Come Around | `songs/Whenever-You-Come-Around.md` | `whenever-you-come-around` | 8 |
| `Where-the-Streets-Have-No-Names.md` | Where the Streets Have No Names | `songs/Where-the-Streets-Have-No-Names.md` | `where-the-streets-have-no-names` | 12 |
| `White-Wedding.md` | White Wedding | `songs/White-Wedding.md` | `white-wedding` | 11 |
| `Wicked-Game.md` | Wicked Game | `songs/Wicked-Game.md` | `wicked-game` | 10 |
| `Wicked-Garden.md` | Wicked Garden | `songs/Wicked-Garden.md` | `wicked-garden` | 10 |
| `Wine-Wine-Wine.md` | Wine Wine Wine | `songs/Wine-Wine-Wine.md` | `wine-wine-wine` | 0 |
| `With-Arms-Wide-Open.md` | With Arms Wide Open | `songs/With-Arms-Wide-Open.md` | `with-arms-wide-open` | 0 |
| `With-Or-Without-You.md` | With Or Without You | `songs/With-Or-Without-You.md` | `with-or-without-you` | 0 |
| `Woman.md` | Woman | `songs/Woman.md` | `woman` | 0 |
| `Wonderwall.md` | Wonderwall | `songs/Wonderwall.md` | `wonderwall` | 0 |
| `Word-Up.md` | Word Up | `songs/Word-Up.md` | `word-up` | 0 |
| `Yellow-Ledbetter.md` | Yellow Ledbetter | `songs/Yellow-Ledbetter.md` | `yellow-ledbetter` | 0 |
| `You-Found-Me.md` | You Found Me | `songs/You-Found-Me.md` | `you-found-me` | 0 |
| `You-Oughta-Know.md` | You Oughta Know | `songs/You-Oughta-Know.md` | `you-oughta-know` | 11 |
| `You-Shook-Me-All-Night-Long.md` | You Shook Me All Night Long | `songs/You-Shook-Me-All-Night-Long.md` | `you-shook-me-all-night-long` | 9 |
| `You-Wreck-Me.md` | You Wreck Me | `songs/You-Wreck-Me.md` | `you-wreck-me` | 15 |

## Unsectioned sheets

These are retained without invented section labels. Review paths are listed in the machine-readable manifest.

| Count | Status |
| ---: | --- |
| 167 | retained byte-for-byte; needs structural review |
