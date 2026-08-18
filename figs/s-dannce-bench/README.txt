March 04, 2025 

This dataverse repository contains tracking, behavioral clustering, and movie data referred to in: 

Klibaite, U.*, Li, T.*, Aldarondo, D., Akoad, J.F., Ölveczky, B.P. and Dunn, T.W., 2025. Mapping the landscape of social behavior. Cell.


The repository is split into several types of data.

The following folders contain lone and social kinematic tracking, along with behavioral annotation.

ARID1B cohort - 212 files
CHD8 cohort - 360 files
CNTNAP2 cohort - 146 files
FMR1 cohort - 276 files
GRIN2B cohort - 120 files
NRXN1 cohort - 208 files
SCN2A cohort - 120 files
LONG EVANS cohort - 120 files
MOUSE cohort - 128 files


Each .mat file constains a structure called sdannce which contains all tracking and identifying information for the given recording:



>> load('SCN2A_M1_20220922_0448_S.mat')
>> sdannce

sdannce = 

  struct with fields:

          ratgroup: 'SCN2A'
           ratdate: '20220922'
            isamph: 0
           isamphP: 0
             issoc: 1
             ratid: 'M1'
            ratint: 701
            ratgen: 0
           ratp_id: 'M2'
          ratp_int: 702
          ratp_gen: 0
                m1: [90000×3×23 double]
                m2: [90000×3×23 double]
              llac: [90000×1 double]
         part_llac: [90000×1 double]
              hlac: [90000×1 double]
         part_hlac: [90000×1 double]
              lljc: [90000×1 double]
              hljc: [90000×1 double]
         part_lljc: [90000×1 double]
         part_hljc: [90000×1 double]
         cz_action: [90000×2 double]
    part_cz_action: [90000×2 double]
          sz_joint: [90000×2 double]
     part_sz_joint: [90000×2 double]
        og_rat_num: 1



Fields identify which cohort the animal is from, the date the videos were recorded, the animal ID ('M1'), the genotype (0 = WT, 1 = KO), the ID and genotype of the partner animal. 

m1 and m2 are 3D kinematic tracks a inferred by sDANNCE 

Low-level (ll) and high-level (hl) clusters, as well as the original tSNE embeddings (cz_action, and cz_joint) are included for the focal and partner animals. Further cluster descriptions and feature information is stored in Supplementary Table 1.



The following folders contain 6 simultaneously recorded videos and sDANNCE tracking for one of the ASD cohorts (SCN2A) as well as for rat videos with bedding and rat triads. Folders contain calibration files, videos, labels produced using Label3D for COMS (center-of-mass annotations) as well as keypoints in the case of the 'BEDDING' dataset, and sDANNCE inferred kinematics. SCN2A videos correspond to the tracking and annotation files mentioned above in the 'SCN2A cohort' dataset. 

SCN2A_SOC1 - 15 folders (6 rats, round-robin meeting round 1)
SCN2A_SOC2 - 15 folders (6 rats, round-robin meeting round 2)
SCN2A_SOC3 - 15 folders (6 rats, round-robin meeting round 3)
SCN2A_WK1 - 30 folders (6 rats, 5 lone recordings each)
BEDDING - 6 folders (female rats on bedding with additional labels)
TRIADS - 6 folders (male rats from CHD8 cohort)
